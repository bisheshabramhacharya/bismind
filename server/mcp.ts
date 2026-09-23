/**
 * BisMind MCP bridge.
 *
 * Runs as a stdio MCP server for any agent CLI (Claude Code, Codex, Cursor, Devin,
 * Grok, Pi, opencode, …). Every tool call drives the BisMind pane server, so the
 * calling agent can open real terminals running *other* CLIs as sub-agents and read
 * their output back.
 */
import { readToken } from './store.ts';

const PORT = Number(process.env.BISMIND_PORT ?? 4317);
const BASE = process.env.BISMIND_URL ?? `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.BISMIND_TOKEN ?? readToken();

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

async function api(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-bismind-token': TOKEN },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    const message = typeof parsed === 'object' && parsed && 'error' in parsed ? String((parsed as { error: unknown }).error) : text;
    throw new Error(`BisMind API ${res.status}: ${message}`);
  }
  return parsed;
}

export const TOOLS = [  {
    name: 'list_clis',
    description:
      'List the agent CLIs installed on this machine (Claude Code, Codex, Cursor Agent, Devin, Grok, Pi, opencode, shell…) that BisMind can launch in a pane.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'spawn_agent',
    description:
      'Open a new BisMind pane running another agent CLI as a sub-agent. With a prompt the CLI runs headlessly (Claude Code `-p`, Codex `exec`, Cursor `-p`, Devin `-p`, …); without one it opens the interactive TUI. Returns immediately with a pane_id.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: { type: 'string', description: 'CLI id from list_clis, e.g. "codex", "devin", "claude", "cursor", "shell".' },
        prompt: { type: 'string', description: 'Task for the sub-agent. Omit to open the interactive TUI.' },
        cwd: { type: 'string', description: 'Working directory for the pane. Defaults to $HOME.' },
        title: { type: 'string', description: 'Label shown on the pane.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI arguments.' },
        mode: { type: 'string', enum: ['auto', 'interactive', 'exec'], description: 'auto = headless when available; interactive = visible TUI.' },
        headed: { type: 'boolean', description: 'True opens the visible TUI in the canvas so the human can watch the sub-agent work (default true for spawn_agent).' },
        model: { type: 'string', description: 'Model for the sub-agent, e.g. "gpt-5" or "deepseek-chat".' },
        provider: { type: 'string', description: 'Provider for CLIs that need one (pi uses --provider, e.g. "openai", "deepseek").' },
        parent_pane_id: { type: 'string', description: 'Pane that spawned this sub-agent, so the canvas can draw the parent link.' },
        wait_ms: { type: 'number', description: 'If set, wait up to this long for the first output and return it.' },
      },
      required: ['cli'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_agent',
    description:
      'One-shot sub-agent call: spawn a CLI with a prompt, wait for it to finish (or go idle), return its output, and optionally close the pane. Runs headed (visible TUI) by default — pass headed:false for a quiet headless run.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: { type: 'string' },
        prompt: { type: 'string' },
        cwd: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        model: { type: 'string' },
        provider: { type: 'string' },
        timeout_ms: { type: 'number', description: 'Default 300000 (5 minutes).' },
        keep_open: { type: 'boolean', description: 'Leave the pane in the canvas after it finishes (default true).' },
        parent_pane_id: { type: 'string' },
      },
      required: ['cli', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_panes',
    description: 'List every pane in the BisMind canvas with its CLI, working directory, status and parent pane.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_pane',
    description: 'Read the recent terminal output of a pane as plain text (ANSI stripped).',
    inputSchema: {
      type: 'object',
      properties: { pane_id: { type: 'string' }, lines: { type: 'number', description: 'Default 200.' } },
      required: ['pane_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_agent',
    description: 'Block until a sub-agent exits, goes idle, or prints a pattern. Returns the pane output so far.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'string' },
        until: { type: 'string', enum: ['exit', 'idle', 'pattern'], description: 'Default exit.' },
        pattern: { type: 'string', description: 'Required when until=pattern.' },
        timeout_ms: { type: 'number', description: 'Default 300000.' },
      },
      required: ['pane_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_pane',
    description: 'Type into a pane (e.g. answer an interactive prompt in a sub-agent TUI).',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Append Enter (default true).' },
      },
      required: ['pane_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_pane',
    description: 'Kill a pane and its sub-agent process.',
    inputSchema: { type: 'object', properties: { pane_id: { type: 'string' } }, required: ['pane_id'], additionalProperties: false },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in a real pane (visible in the canvas) and return its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout_ms: { type: 'number', description: 'Default 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
] as const;

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_clis': {
      const data = (await api('/api/clis')) as { clis: unknown };
      return data.clis;
    }
    case 'list_panes': {
      const data = (await api('/api/panes')) as { panes: unknown };
      return data.panes;
    }
    case 'spawn_agent': {
      const pane = await api('/api/panes', {
        method: 'POST',
        body: {
          cli: args.cli,
          prompt: args.prompt ?? null,
          cwd: args.cwd,
          title: args.title,
          args: args.args ?? [],
          mode: args.mode ?? 'auto',
          headed: args.headed ?? (args.mode === 'exec' ? false : true),
          model: args.model ?? null,
          provider: args.provider ?? null,
          parent_pane_id: args.parent_pane_id,
        },
      });
      const id = (pane as { pane: { id: string } }).pane.id;
      if (args.wait_ms) {
        const waited = (await api(`/api/panes/${id}/wait`, {
          method: 'POST',
          body: { until: 'idle', timeout_ms: args.wait_ms },
        })) as { output: string };
        return { pane, output: waited.output };
      }
      return pane;
    }
    case 'ask_agent': {
      const spawned = (await api('/api/panes', {
        method: 'POST',
        body: {
          cli: args.cli,
          prompt: args.prompt,
          cwd: args.cwd,
          args: args.args ?? [],
          mode: args.headed === false ? 'exec' : 'interactive',
          headed: args.headed !== false,
          model: args.model ?? null,
          provider: args.provider ?? null,
          parent_pane_id: args.parent_pane_id,
        },
      })) as { pane: { id: string; status: string; mode: string } };
      const id = spawned.pane.id;
      const result = (await api(`/api/panes/${id}/wait`, {
        method: 'POST',
        body: { until: 'exit', timeout_ms: args.timeout_ms ?? 300_000 },
      })) as { pane: { status: string; exitCode: number | null }; output: string; reason: string; matched: boolean };
      if (args.keep_open === false) await api(`/api/panes/${id}`, { method: 'DELETE' });
      return {
        pane_id: id,
        cli: args.cli,
        cwd: args.cwd ?? null,
        status: result.pane.status,
        exit_code: result.pane.exitCode,
        finished: result.reason !== 'timeout',
        output: result.output,
      };
    }
    case 'read_pane': {
      const lines = Number(args.lines ?? 200);
      const data = (await api(`/api/panes/${args.pane_id}?lines=${lines}`)) as { pane: unknown; output: string };
      return { pane: data.pane, output: data.output };
    }
    case 'wait_for_agent': {
      const result = (await api(`/api/panes/${args.pane_id}/wait`, {
        method: 'POST',
        body: { until: args.until ?? 'exit', pattern: args.pattern, timeout_ms: args.timeout_ms ?? 300_000 },
      })) as { pane: unknown; output: string; reason: string; matched: boolean };
      return { pane: result.pane, matched: result.matched, reason: result.reason, output: result.output };
    }
    case 'send_to_pane': {
      await api(`/api/panes/${args.pane_id}/input`, { method: 'POST', body: { text: args.text, submit: args.submit ?? true } });
      return { ok: true };
    }
    case 'close_pane': {
      await api(`/api/panes/${args.pane_id}`, { method: 'DELETE' });
      return { ok: true };
    }
    case 'run_command': {
      const spawned = (await api('/api/panes', {
        method: 'POST',
        body: { cli: 'shell', cwd: args.cwd, mode: 'interactive', title: String(args.command).slice(0, 48) },
      })) as { pane: { id: string } };
      const id = spawned.pane.id;
      await new Promise(r => setTimeout(r, 500));
      await api(`/api/panes/${id}/input`, { method: 'POST', body: { text: args.command, submit: true } });
      const result = (await api(`/api/panes/${id}/wait`, {
        method: 'POST',
        body: { until: 'idle', timeout_ms: args.timeout_ms ?? 120_000 },
      })) as { output: string; matched: boolean };
      return { pane_id: id, output: result.output };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function write(msg: unknown) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(req: RpcRequest) {
  const { id, method, params } = req;
  const reply = (result: unknown) => id !== undefined && id !== null && write({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => id !== undefined && id !== null && write({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: (params?.protocolVersion as string) ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'bismind', version: '0.1.0' },
        instructions:
          'BisMind runs real CLI terminals in a pane canvas. Use list_clis to see installed agents, then spawn_agent / ask_agent to delegate work to other CLIs (Codex, Devin, Cursor, Grok, Pi, …) as sub-agents. read_pane and wait_for_agent bring their output back.',
      });
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      try {
        const result = await callTool(name, args);
        return reply(text(result));
      } catch (err) {
        return reply({
          isError: true,
          content: [{ type: 'text', text: `BisMind error: ${err instanceof Error ? err.message : String(err)}` }],
        });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export function startMcp() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          void handle(JSON.parse(line) as RpcRequest);
        } catch {
          /* ignore malformed frame */
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
