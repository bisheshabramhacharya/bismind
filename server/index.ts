import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { panes } from './panes.ts';
import { listClis, allSpecs, findBin } from './registry.ts';
import { LOG_PATH, addWorkspace, patchState, readState, readToken, removeWorkspace } from './store.ts';
import type { PaneInfo } from './types.ts';

const PORT = Number(process.env.BISMIND_PORT ?? 4317);
const HOST = '127.0.0.1';
const TOKEN = readToken();
const STATIC_DIR = process.env.BISMIND_STATIC ?? join(process.cwd(), 'dist', 'web');

type Json = Record<string, unknown>;

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-bismind-token',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
  } catch {
    return {};
  }
}

function authorized(req: IncomingMessage, url: URL): boolean {
  const header = req.headers['x-bismind-token'];
  const token = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? url.searchParams.get('t');
  return token === TOKEN;
}

function paneSummary(p: PaneInfo) {
  return {
    id: p.id,
    title: p.title,
    cli: p.cli,
    cliLabel: p.cliLabel,
    accent: p.accent,
    cwd: p.cwd,
    status: p.status,
    mode: p.mode,
    exitCode: p.exitCode,
    parentId: p.parentId,
    prompt: p.prompt,
    model: p.model,
    provider: p.provider,
    headed: p.headed,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    command: p.command,
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res: ServerResponse, pathname: string) {
  if (!existsSync(STATIC_DIR)) {
    send(res, 404, { error: 'web build not found — run `pnpm dev` for the dev server or `pnpm build` first' });
    return;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = resolve(join(STATIC_DIR, rel));
  if (!file.startsWith(resolve(STATIC_DIR))) {
    send(res, 403, { error: 'forbidden' });
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  const body = readFileSync(file) as Buffer;
  if (file.endsWith('index.html')) {
    const html = body.toString('utf8').replace('<head>', `<head><script>window.__BISMIND_TOKEN__=${JSON.stringify(TOKEN)}</script>`);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, action] = parts;

  if (resource === 'health') {
    send(res, 200, { ok: true, service: 'bismind', panes: panes.list().length, pid: process.pid, log: LOG_PATH });
    return true;
  }
  if (resource === 'clis') {
    send(res, 200, { clis: listClis(), specs: allSpecs().map(s => ({ id: s.id, label: s.label, hasExec: Boolean(s.exec), hint: s.hint })) });
    return true;
  }
  if (resource === 'state') {
    if (req.method === 'PATCH' || req.method === 'POST') {
      const body = await readBody(req);
      send(res, 200, patchState(body as never));
      return true;
    }
    send(res, 200, readState());
    return true;
  }
  if (resource === 'fs') {
    const target = url.searchParams.get('path') ?? homedir();
    const abs = resolve(target.replace(/^~/, homedir()));
    try {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: join(abs, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      send(res, 200, { path: abs, parent: resolve(abs, '..'), entries });
    } catch (err) {
      send(res, 400, { error: String(err) });
    }
    return true;
  }
  if (resource === 'workspaces') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const path = String(body.path ?? '').replace(/^~/, homedir());
      if (!path || !existsSync(path)) {
        send(res, 400, { error: 'path does not exist' });
        return true;
      }
      send(res, 200, addWorkspace(path, body.name ? String(body.name) : undefined));
      return true;
    }
    if (req.method === 'DELETE' && id) {
      removeWorkspace(id);
      send(res, 200, { ok: true });
      return true;
    }
    send(res, 200, { workspaces: readState().workspaces });
    return true;
  }
  if (resource === 'panes') {
    if (req.method === 'GET' && !id) {
      send(res, 200, { panes: panes.list().map(paneSummary) });
      return true;
    }
    if (req.method === 'POST' && !id) {
      const body = await readBody(req);
      try {
        const info = panes.spawn({
          cli: String(body.cli ?? 'shell'),
          cwd: body.cwd ? String(body.cwd) : undefined,
          prompt: body.prompt === undefined || body.prompt === null ? null : String(body.prompt),
          title: body.title ? String(body.title) : undefined,
          mode: body.mode === 'interactive' || body.mode === 'exec' ? body.mode : 'auto',
          headed: body.headed === undefined ? undefined : Boolean(body.headed),
          model: body.model ? String(body.model) : null,
          provider: body.provider ? String(body.provider) : null,
          args: Array.isArray(body.args) ? (body.args as unknown[]).map(String) : [],
          cols: Number(body.cols ?? 120),
          rows: Number(body.rows ?? 30),
          parentId: body.parent_pane_id ? String(body.parent_pane_id) : body.parentId ? String(body.parentId) : null,
        });
        send(res, 200, { pane: paneSummary(info) });
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (id && req.method === 'GET') {
      const info = panes.get(id);
      if (!info) {
        send(res, 404, { error: 'unknown pane' });
        return true;
      }
      const lines = Number(url.searchParams.get('lines') ?? 200);
      send(res, 200, { pane: paneSummary(info), output: panes.output(id, lines) });
      return true;
    }
    if (id && req.method === 'DELETE') {
      panes.kill(id);
      send(res, 200, { ok: true });
      return true;
    }
    if (id && action === 'input' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        panes.send(id, String(body.text ?? ''), body.submit === undefined ? true : Boolean(body.submit));
        send(res, 200, { ok: true });
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (id && action === 'wait' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = await panes.wait(id, {
          until: body.until === 'idle' || body.until === 'pattern' ? body.until : body.until === 'exit' ? 'exit' : undefined,
          pattern: body.pattern ? String(body.pattern) : undefined,
          timeoutMs: body.timeout_ms ? Number(body.timeout_ms) : body.timeoutMs ? Number(body.timeoutMs) : undefined,
        });
        send(res, 200, { ...result, pane: paneSummary(result.pane) });
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    send(res, 405, { error: `unsupported ${req.method} ${url.pathname}` });
    return true;
  }
  if (resource === 'specs') {
    send(res, 200, { clis: listClis(), bins: allSpecs().map(s => ({ id: s.id, bin: findBin(s.bins) })) });
    return true;
  }
  return false;
}

export function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-bismind-token', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) return send(res, 401, { error: 'bad or missing token' });
      handleApi(req, res, url).then(handled => {
        if (!handled) send(res, 404, { error: 'not found' });
      }).catch(err => send(res, 500, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    serveStatic(res, url.pathname);
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const subscriptions = new Map<WebSocket, Set<string>>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    if (url.pathname !== '/ws' || !authorized(req, url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    clients.add(ws);
    subscriptions.set(ws, new Set());
    ws.send(JSON.stringify({ type: 'hello', panes: panes.list().map(paneSummary), state: readState() }));

    ws.on('message', raw => {
      let msg: Json;
      try {
        msg = JSON.parse(String(raw)) as Json;
      } catch {
        return;
      }
      const subs = subscriptions.get(ws)!;
      if (msg.type === 'attach' && msg.paneId) {
        const paneId = String(msg.paneId);
        subs.add(paneId);
        ws.send(JSON.stringify({ type: 'snapshot', paneId, data: panes.raw(paneId) }));
        if (msg.cols && msg.rows) panes.resize(paneId, Number(msg.cols), Number(msg.rows));
      }
      if (msg.type === 'detach' && msg.paneId) subs.delete(String(msg.paneId));
      if (msg.type === 'input' && msg.paneId) {
        try {
          panes.write(String(msg.paneId), String(msg.data ?? ''));
        } catch {
          /* pane gone */
        }
      }
      if (msg.type === 'resize' && msg.paneId) panes.resize(String(msg.paneId), Number(msg.cols), Number(msg.rows));
    });

    ws.on('close', () => {
      clients.delete(ws);
      subscriptions.delete(ws);
    });
  });

  const broadcast = (payload: Json, paneId?: string) => {
    const text = JSON.stringify(payload);
    for (const client of clients) {
      if (paneId) {
        const subs = subscriptions.get(client);
        if (subs && subs.size > 0 && !subs.has(paneId)) continue;
      }
      if (client.readyState === client.OPEN) client.send(text);
    }
  };

  panes.on('data', ({ id, chunk }: { id: string; chunk: string }) => broadcast({ type: 'data', paneId: id, data: chunk }, id));
  panes.on('status', ({ id, status, exitCode }: { id: string; status: string; exitCode: number | null }) =>
    broadcast({ type: 'status', paneId: id, status, exitCode }),
  );
  panes.on('created', (pane: PaneInfo) => broadcast({ type: 'created', pane: paneSummary(pane) }));
  panes.on('closed', ({ id }: { id: string }) => broadcast({ type: 'closed', paneId: id }));

  server.listen(PORT, HOST, () => {
    console.log(`[bismind] api  http://${HOST}:${PORT}`);
    console.log(`[bismind] token ${TOKEN}`);
    console.log(`[bismind] open http://127.0.0.1:${process.env.BISMIND_WEB_PORT ?? 5317}/?t=${TOKEN}`);
  });

  const shutdown = () => {
    panes.killAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

startServer();
