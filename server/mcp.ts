/**
 * BisMind MCP bridge (stdio). Gives Claude Code, Codex, or any MCP client the sub-agent
 * tools. It answers the handshake immediately and only reaches the server on the first
 * tool call, so a slow or stopped server can never time out the client's startup.
 */
import { api } from './client.ts';

const PARENT = process.env.BISMIND_AGENT_ID ?? null;
/** Sub-agents get ask_parent instead of the orchestration tools, so they can't fan out recursively. */
const IS_SUB = process.env.BISMIND_ROLE === 'sub';
/** Sub-agents spawned through this bridge, for callers that run outside BisMind (no parent id). */
const spawnedHere: string[] = [];

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Complete, self-contained brief: goal, relevant files, constraints, how to verify, what to report. The sub-agent starts with zero context.' },
    name: { type: 'string', description: 'Short name for the pane, e.g. "auth-api". Defaults to one derived from the task.' },
    harness: { type: 'string', enum: ['claude', 'codex', 'pi', 'devin'], description: "Only if the user asked for a specific harness. Defaults to the user's sub-agent mode." },
    model: { type: 'string', description: 'Only if the user asked for a specific model (pi uses "provider/model").' },
    thinking: { type: 'string', description: 'Reasoning effort: low, medium, high, xhigh, max.' },
    cwd: { type: 'string', description: "Working directory. Defaults to yours." },
    isolate: { type: 'boolean', description: 'Give this sub-agent its own git worktree and branch. Use when parallel sub-agents edit the same repo.' },
    issue: { type: 'integer', minimum: 1, description: 'GitHub issue number this sub-agent works on. Implies isolate; it pushes its branch and opens a PR that closes the issue.' },
  },
  required: ['task'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'spawn_subagents',
    description:
      "Start one or more sub-agents in parallel, each in a visible BisMind terminal pane, using the user's sub-agent mode (harness + model). Returns immediately with their ids. Put all independent tasks in ONE call, then end your turn: BisMind wakes you when one asks a question.",
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: TASK_SCHEMA, minItems: 1, maxItems: 12 },
        cwd: { type: 'string', description: 'Default working directory for every task.' },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_subagents',
    description:
      'Block until your sub-agents finish (until="all", default) or until any one settles (until="any"). A sub-agent also settles when it asks you a question. Returns each one\'s status and final report. Prefer this over polling.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Sub-agent ids or names. Defaults to all of yours.' },
        until: { type: 'string', enum: ['all', 'any'] },
        timeout_seconds: { type: 'number', description: 'Default 900. On timeout you get progress; call again to keep waiting.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'message_subagent',
    description: 'Send a message to a sub-agent: answer its question, correct course, or give a follow-up task. It starts a new turn; wait again afterwards.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Sub-agent id or name.' }, text: { type: 'string' } },
      required: ['id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_subagent',
    description:
      "Read any BisMind agent (a sub-agent, or one the user referenced as @bismind:<id>): its task, status, last report and what is on its terminal right now. Useful for checking a stuck agent; don't use it to poll.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, lines: { type: 'number', description: 'Default 120.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'review_subagents',
    description:
      "Start one read-only reviewer per finished sub-agent that has its own branch and no review yet (or the ids you pass), on the review agent the user configured. Each reviewer returns 'Verdict: APPROVE | CHANGES REQUESTED' with problems at file:line. Reviewers are your sub-agents named review-<worker>.",
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Sub-agents to review. Defaults to every finished, unreviewed one.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'stop_subagent',
    description: 'Stop a sub-agent. close=true also removes its pane; otherwise the pane stays listed with its result.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, close: { type: 'boolean' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_subagents',
    description: 'List your sub-agents with status and results.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'subagent_mode',
    description: "Show the user's current sub-agent mode (which harness and model new sub-agents use) and which harnesses are installed.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const SUB_TOOLS = [
  {
    name: 'ask_parent',
    description:
      'Ask the agent that gave you this task ONE question and pause. Use it when requirements are ambiguous, a decision would materially change your work, or you are blocked. Prefer asking over guessing on anything that matters; make reasonable calls on small things. After calling this, END YOUR TURN — the answer arrives as your next message. Include enough context that it can be answered without reading your whole task.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'One self-contained question.' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_progress',
    description: 'Optional: post a one-line progress note your parent and the user can see (e.g. "tests written, fixing 2 failures"). Does not pause you.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
  },
];

async function callTool(name: string, args: Record<string, any>): Promise<unknown> {
  // tools/list hides the other role's tools; enforce it too, since a client can call any name.
  const subOnly = SUB_TOOLS.some(t => t.name === name);
  if (IS_SUB && !subOnly) throw new Error(`sub-agents can't use ${name}; do the work yourself or say what's needed in your report`);
  if (!IS_SUB && subOnly) throw new Error(`${name} is only for sub-agents`);
  switch (name) {
    case 'ask_parent':
      if (!PARENT) throw new Error('ask_parent only works inside a BisMind sub-agent');
      await api(`/api/agents/${PARENT}/ask`, { body: { question: args.question } });
      return 'Question sent to your parent. End your turn now and wait; the answer will arrive as your next message. Do not guess the answer or keep working on the parts that depend on it.';
    case 'report_progress':
      if (!PARENT) throw new Error('report_progress only works inside a BisMind sub-agent');
      await api(`/api/agents/${PARENT}/progress`, { body: { note: args.note } });
      return 'Noted.';
    case 'spawn_subagents': {
      const out = await api<{ spawned: { ok: boolean; id?: string }[] }>('/api/subagents', { body: { parentId: PARENT, tasks: args.tasks, cwd: args.cwd ?? process.cwd() }, timeoutMs: 120_000 });
      for (const s of out.spawned) if (s.ok && s.id) spawnedHere.push(s.id);
      return { ...out, next: 'Sub-agents are running in visible panes. End your turn now unless you need their results to continue; BisMind wakes you if one asks a question.' };
    }
    case 'wait_subagents': {
      const timeoutMs = Math.round((args.timeout_seconds ?? 900) * 1000);
      const ids = args.ids?.length ? args.ids : PARENT ? undefined : spawnedHere;
      return api('/api/wait', { body: { parentId: PARENT, ids, until: args.until ?? 'all', timeoutMs }, timeoutMs: timeoutMs + 30_000 });
    }
    case 'message_subagent':
      await api(`/api/agents/${encodeURIComponent(args.id)}/message`, { body: { text: args.text } });
      return { ok: true, next: 'Message delivered. Call wait_subagents to get its next result.' };
    case 'read_subagent':
      return api(`/api/agents/${encodeURIComponent(args.id)}/read?lines=${Number(args.lines ?? 120)}`);
    case 'review_subagents':
      if (!PARENT) throw new Error('review_subagents only works inside BisMind');
      return api('/api/review', { body: { parentId: PARENT, ids: args.ids }, timeoutMs: 120_000 });
    case 'stop_subagent':
      await api(`/api/agents/${encodeURIComponent(args.id)}${args.close ? '' : '/stop'}`, { method: args.close ? 'DELETE' : 'POST' });
      return { ok: true };
    case 'list_subagents':
      return PARENT ? api(`/api/subagents?parent=${PARENT}`) : Promise.all(spawnedHere.map(id => api(`/api/agents/${id}`).catch(() => null)));
    case 'subagent_mode':
      return api('/api/mode');
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function write(msg: unknown) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg: { id?: number | string | null; method: string; params?: any }) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    switch (method) {
      case 'initialize':
        return write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'bismind', version: '0.5.0' },
            instructions: IS_SUB
              ? 'You are a BisMind sub-agent. Use ask_parent when blocked on a decision only your parent can make; your final message is your report.'
              : "BisMind runs sub-agents on any harness (pi, Codex, Claude Code, Devin) in visible terminal panes, using the user's chosen sub-agent mode. Spawn independent tasks together with spawn_subagents, then wait_subagents.",
          },
        });
      case 'ping':
        return write({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return write({ jsonrpc: '2.0', id, result: { tools: IS_SUB ? SUB_TOOLS : TOOLS } });
      case 'tools/call': {
        try {
          const out = await callTool(params?.name, params?.arguments ?? {});
          return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
        } catch (err) {
          return write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] } });
        }
      }
      default:
        return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (err) {
    write({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
  }
}

export function startMcp() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line));
      } catch {
        /* ignore malformed input */
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
