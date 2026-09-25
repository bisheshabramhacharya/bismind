/**
 * BisMind server: REST API for the UI, MCP bridge, hooks and CLI; WebSocket for live
 * terminals; and the built UI. Binds to 127.0.0.1 only and requires the token in
 * ~/.bismind/token.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { agents } from './agents.ts';
import { PORT, REPO, parseModeSpec, patchSettings, readSettings, readToken, type Settings } from './config.ts';
import { harnesses } from './harnesses.ts';
import { modelsFor } from './models.ts';
import { modeInfo, reviewSubagents, spawnSubagents, summarize, waitFor } from './orchestrate.ts';
import { tmux, writeTmuxConf } from './tmux.ts';

process.removeAllListeners('warning');
const TOKEN = readToken();
const DIST = join(REPO, 'dist');

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function authed(req: IncomingMessage, url: URL): boolean {
  return req.headers['x-bismind-token'] === TOKEN || url.searchParams.get('t') === TOKEN;
}

function clampTimeout(ms: unknown, fallback: number): number {
  const n = Number(ms);
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : fallback, 1000), 60 * 60_000);
}

function state() {
  return { settings: readSettings(), agents: agents.list(), harnesses: harnesses(), mode: modeInfo(), home: homedir() };
}

function broadcastSettings(settings: Settings) {
  broadcast({ type: 'settings', settings, mode: modeInfo() });
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const seg = path.split('/').filter(Boolean); // ['api', ...]

  if (path === '/api/health') return send(res, 200, { ok: true, pid: process.pid, agents: agents.list().length, tmux: tmux.available });
  if (path === '/api/state' && method === 'GET') return send(res, 200, state());

  if (path === '/api/settings' && method === 'PATCH') {
    const b = await body(req);
    const patch: Partial<Settings> = {};
    if (typeof b.modeSpec === 'string') patch.mode = parseModeSpec(b.modeSpec);
    if (b.mode && typeof b.mode === 'object') {
      if (!['native', 'claude', 'codex', 'pi', 'devin'].includes(b.mode.harness)) throw new HttpError(400, 'mode.harness must be native, claude, codex, pi or devin');
      patch.mode = {
        harness: b.mode.harness,
        model: typeof b.mode.model === 'string' && b.mode.model ? b.mode.model : null,
        thinking: typeof b.mode.thinking === 'string' && b.mode.thinking ? b.mode.thinking : null,
      };
    }
    if (b.autonomy === 'full' || b.autonomy === 'ask') patch.autonomy = b.autonomy;
    if (b.ui) patch.ui = b.ui;
    if ('activeWorkspace' in b) patch.activeWorkspace = b.activeWorkspace;
    if (b.review && typeof b.review === 'object') {
      const r = b.review;
      if (!['mode', 'claude', 'codex', 'pi', 'devin'].includes(r.harness)) throw new HttpError(400, 'review.harness must be mode, claude, codex, pi or devin');
      patch.review = {
        harness: r.harness,
        model: typeof r.model === 'string' && r.model ? r.model : null,
        thinking: typeof r.thinking === 'string' && r.thinking ? r.thinking : null,
        instructions: typeof r.instructions === 'string' ? r.instructions.slice(0, 4000) : '',
      };
    }
    const next = patchSettings(patch);
    broadcastSettings(next);
    return send(res, 200, { settings: next, mode: modeInfo() });
  }

  if (path === '/api/mode' && method === 'GET') return send(res, 200, modeInfo());
  if (path === '/api/models' && method === 'GET') {
    const h = url.searchParams.get('harness') ?? 'pi';
    return send(res, 200, { harness: h, models: await modelsFor(h, url.searchParams.has('refresh')) });
  }

  if (path === '/api/dirs' && method === 'GET') {
    // Folder suggestions for the "add workspace" box: "~/Doc" → ~/Documents, …
    const raw = (url.searchParams.get('prefix') ?? '~/').replace(/^~(?=$|\/)/, homedir());
    const dir = raw.endsWith('/') ? raw : raw.slice(0, raw.lastIndexOf('/') + 1) || '/';
    const partial = raw.slice(dir.length).toLowerCase();
    let names: string[] = [];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name.toLowerCase().startsWith(partial))
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 12);
    } catch {
      /* unreadable */
    }
    const home = homedir();
    return send(res, 200, names.map(n => join(dir, n)).map(p => (p.startsWith(home) ? `~${p.slice(home.length)}` : p)));
  }

  if (path === '/api/workspaces' && method === 'POST') {
    const b = await body(req);
    const p = resolve(String(b.path ?? '').replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new HttpError(400, `not a folder: ${p}`);
    const s = readSettings();
    let ws = s.workspaces.find(w => w.path === p);
    if (!ws) ws = { id: randomBytes(4).toString('hex'), name: b.name?.trim() || p.split('/').filter(Boolean).pop() || p, path: p };
    const next = patchSettings({ workspaces: s.workspaces.some(w => w.id === ws!.id) ? s.workspaces : [...s.workspaces, ws], activeWorkspace: ws.id });
    broadcastSettings(next);
    return send(res, 200, ws);
  }
  if (seg[1] === 'workspaces' && seg[2] && method === 'DELETE') {
    const s = readSettings();
    const next = patchSettings({ workspaces: s.workspaces.filter(w => w.id !== seg[2]), activeWorkspace: s.activeWorkspace === seg[2] ? null : s.activeWorkspace });
    broadcastSettings(next);
    return send(res, 200, { ok: true });
  }

  if (path === '/api/agents' && method === 'GET') return send(res, 200, agents.list());
  if (path === '/api/agents' && method === 'POST') {
    const b = await body(req);
    const s = readSettings();
    const ws = s.workspaces.find(w => w.id === b.workspaceId);
    const agent = await agents.spawn({
      harness: b.harness,
      cwd: b.cwd ?? ws?.path ?? homedir(),
      workspaceId: ws?.id ?? null,
      model: b.model ?? null,
      thinking: b.thinking ?? null,
      name: b.name ?? null,
      task: b.prompt ?? null,
      cols: b.cols,
      rows: b.rows,
    });
    return send(res, 200, agent);
  }

  if (seg[1] === 'agents' && seg[2]) {
    const id = seg[2];
    const action = seg[3];
    if (!action && method === 'GET') return send(res, 200, await summarize(agents.must(id), true));
    if (!action && method === 'DELETE') {
      await agents.kill(id);
      return send(res, 200, { ok: true });
    }
    if (action === 'stop' && method === 'POST') {
      await agents.stop(id);
      return send(res, 200, { ok: true });
    }
    if (action === 'message' && method === 'POST') {
      const b = await body(req);
      if (!b.text) throw new HttpError(400, 'text is required');
      await agents.message(id, String(b.text));
      return send(res, 200, { ok: true });
    }
    if (action === 'read' && method === 'GET') {
      // Everything another agent needs to understand this one: who it is, its task, its report, its screen.
      const a = agents.must(id);
      const parent = a.parentId ? agents.get(a.parentId) : null;
      const screen = await agents.screen(a.id, Number(url.searchParams.get('lines') ?? 120));
      return send(res, 200, { ...(await summarize(a, false)), role: a.role, parent: parent?.name ?? null, task: a.task, screen });
    }
    if (action === 'done' && method === 'POST') {
      const b = await body(req);
      if (!String(b.report ?? '').trim()) throw new HttpError(400, 'report is required');
      agents.finish(agents.must(id).id, String(b.report).trim());
      return send(res, 200, { ok: true });
    }
    if (action === 'screen' && method === 'GET') {
      return send(res, 200, { screen: await agents.screen(id, Number(url.searchParams.get('lines') ?? 120)) });
    }
    if (action === 'event' && method === 'POST') {
      const b = await body(req);
      if (b.type === 'turn_start') agents.turnStarted(id);
      else if (b.type === 'turn_end') agents.turnEnded(id, typeof b.message === 'string' ? b.message : null);
      return send(res, 200, { ok: true });
    }
    if (action === 'progress' && method === 'POST') {
      const b = await body(req);
      agents.progress(agents.must(id).id, String(b.note ?? ''));
      return send(res, 200, { ok: true });
    }
    if (action === 'ask' && method === 'POST') {
      const b = await body(req);
      if (!b.question) throw new HttpError(400, 'question is required');
      agents.ask(id, String(b.question));
      return send(res, 200, { ok: true });
    }
  }

  if (path === '/api/subagents' && method === 'POST') {
    const b = await body(req);
    return send(res, 200, { mode: modeInfo().description, spawned: await spawnSubagents(b.parentId ?? null, b.tasks, b.cwd) });
  }
  if (path === '/api/subagents' && method === 'GET') {
    const parent = url.searchParams.get('parent');
    const list = parent ? agents.children(parent) : agents.list().filter(a => a.role === 'sub');
    return send(res, 200, await Promise.all(list.map(a => summarize(a, false))));
  }
  if (path === '/api/review' && method === 'POST') {
    const b = await body(req);
    if (!b.parentId) throw new HttpError(400, 'parentId is required');
    return send(res, 200, await reviewSubagents(String(b.parentId), Array.isArray(b.ids) ? b.ids : undefined));
  }
  if (path === '/api/wait' && method === 'POST') {
    const b = await body(req);
    const until = b.until === 'any' ? 'any' : 'all';
    // A caller that gives up (timeout, Ctrl-C, a killed tool call) must not keep the parent marked as waiting.
    const gone = new AbortController();
    res.on('close', () => !res.writableEnded && gone.abort());
    return send(res, 200, await waitFor(b.parentId ?? null, b.ids, until, clampTimeout(b.timeoutMs, 10 * 60_000), gone.signal));
  }
  if (path === '/api/notices' && method === 'GET') {
    const parent = url.searchParams.get('parent') ?? '';
    const after = Number(url.searchParams.get('after') ?? 0);
    return send(res, 200, await agents.noticesFor(parent, after, clampTimeout(url.searchParams.get('timeout'), 25_000)));
  }

  throw new HttpError(404, `no route ${method} ${path}`);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function serveStatic(res: ServerResponse, pathname: string) {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('BisMind UI is not built. Run `pnpm build`, or use `pnpm dev` for the dev UI on :5317.');
    return;
  }
  let file = normalize(join(DIST, pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'max-age=31536000' });
  createReadStream(file)
    .on('error', () => res.end())
    .pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (!url.pathname.startsWith('/api/')) {
    try {
      return serveStatic(res, url.pathname);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      return res.end();
    }
  }
  if (!authed(req, url)) return send(res, 401, { error: 'missing or wrong BisMind token' });
  try {
    await route(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── WebSocket: live terminals + state pushes ──────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });
const viewers = new Map<WebSocket, Set<string>>();

function broadcast(msg: unknown) {
  const text = JSON.stringify(msg);
  for (const ws of viewers.keys()) if (ws.readyState === ws.OPEN) ws.send(text);
}

// Coalesce terminal output per agent into ~60fps frames; flush early past 128 KB so bursts stay smooth.
const FLUSH_LIMIT = 128 * 1024;
const pending = new Map<string, string>();
let pendingSize = 0;
let flushTimer: NodeJS.Timeout | null = null;
function flushData() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  for (const [aid, data] of pending) {
    const text = JSON.stringify({ type: 'data', id: aid, data });
    for (const [ws, subs] of viewers) if (subs.has(aid) && ws.readyState === ws.OPEN) ws.send(text);
  }
  pending.clear();
  pendingSize = 0;
}
agents.on('data', ({ id, chunk }: { id: string; chunk: string }) => {
  pending.set(id, (pending.get(id) ?? '') + chunk);
  pendingSize += chunk.length;
  if (pendingSize >= FLUSH_LIMIT) flushData();
  else if (!flushTimer) flushTimer = setTimeout(flushData, 16);
});
agents.on('agent', agent => broadcast({ type: 'agent', agent }));
agents.on('removed', ({ id }) => broadcast({ type: 'removed', id }));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/ws' || url.searchParams.get('t') !== TOKEN) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    viewers.set(ws, new Set());
    ws.send(JSON.stringify({ type: 'state', ...state() }));
    ws.on('message', raw => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const subs = viewers.get(ws);
      if (!subs || typeof msg.id !== 'string') return;
      switch (msg.type) {
        case 'attach':
          subs.add(msg.id);
          agents.attach(msg.id);
          if (msg.cols && msg.rows) agents.resize(msg.id, msg.cols, msg.rows);
          ws.send(JSON.stringify({ type: 'snapshot', id: msg.id, data: agents.snapshot(msg.id) }));
          {
            const a = agents.get(msg.id);
            if (a) setTimeout(() => void tmux.redraw(a.session), 60);
          }
          break;
        case 'detach':
          subs.delete(msg.id);
          break;
        case 'input':
          if (typeof msg.data === 'string') agents.write(msg.id, msg.data);
          break;
        case 'resize':
          agents.resize(msg.id, msg.cols, msg.rows);
          break;
      }
    });
    ws.on('close', () => viewers.delete(ws));
  });
});

async function main() {
  // One bad async path must not take every agent's bookkeeping down with it.
  process.on('unhandledRejection', err => console.error('[bismind] unhandled rejection', err));
  if (!tmux.available) console.error('[bismind] tmux is not installed; run `brew install tmux`');
  writeTmuxConf();
  await agents.start();
  server.on('error', err => {
    console.error(`[bismind] ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bismind] server on http://127.0.0.1:${PORT}/?t=${TOKEN}`);
  });
}

void main();
