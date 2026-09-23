/**
 * BisMind extension for pi. BisMind loads it into every pi it launches (`pi -e`).
 *
 * - Every pi: reports turn start/end (with the final message) to BisMind, which is how a
 *   pi sub-agent's result gets back to its parent.
 * - Main pi agents: sub-agent tools. Results are pushed back as messages that wake pi up,
 *   so pi never has to poll.
 */
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGENT_ID = process.env.BISMIND_AGENT_ID ?? '';
const ROLE = process.env.BISMIND_ROLE ?? 'main';
const URL_BASE = process.env.BISMIND_URL ?? 'http://127.0.0.1:4317';

function token(): string {
  try {
    return readFileSync(join(process.env.BISMIND_HOME ?? join(homedir(), '.bismind'), 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function api(path: string, body?: unknown, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-bismind-token': token() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `BisMind ${res.status}`);
  return data;
}

function lastAssistantText(messages: any[] | undefined): string | null {
  for (const m of [...(messages ?? [])].reverse()) {
    if (m?.role !== 'assistant') continue;
    const content = m.content;
    const text = Array.isArray(content) ? content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : String(content ?? '');
    if (text.trim()) return text;
  }
  return null;
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], details: undefined };
}

export default function bismind(pi: ExtensionAPI) {
  if (!AGENT_ID) return; // not launched by BisMind

  let lastText: string | null = null;
  pi.on('agent_start', () => {
    void api(`/api/agents/${AGENT_ID}/event`, { type: 'turn_start' }).catch(() => undefined);
  });
  pi.on('agent_end', event => {
    lastText = lastAssistantText((event as any).messages) ?? lastText;
  });
  pi.on('agent_settled', () => {
    void api(`/api/agents/${AGENT_ID}/event`, { type: 'turn_end', message: lastText }).catch(() => undefined);
  });

  if (ROLE === 'sub') {
    pi.registerTool({
      name: 'ask_parent',
      label: 'Ask parent',
      description:
        'Ask the agent that gave you this task ONE question and pause. Use it when requirements are ambiguous, a decision would materially change your work, or you are blocked. After calling it, END YOUR TURN; the answer arrives as your next message.',
      parameters: Type.Object({ question: Type.String({ description: 'One self-contained question with enough context to answer it directly.' }) }),
      async execute(_id, params: any) {
        await api(`/api/agents/${AGENT_ID}/ask`, { question: params.question });
        return text('Question sent to your parent. End your turn now; the answer arrives as your next message. Do not guess it.');
      },
    });
    pi.registerTool({
      name: 'report_progress',
      label: 'Report progress',
      description: 'Optional: post a one-line progress note your parent and the user can see. Does not pause you.',
      parameters: Type.Object({ note: Type.String() }),
      async execute(_id, params: any) {
        await api(`/api/agents/${AGENT_ID}/progress`, { note: params.note });
        return text('Noted.');
      },
    });
    return;
  }

  // ── Push results back: long-poll BisMind for notices about this agent's children ──
  let running = false;
  let seq = 0;
  const loop = async () => {
    while (running) {
      try {
        const out = await api(`/api/notices?parent=${AGENT_ID}&after=${seq}&timeout=25000`, undefined, 35_000);
        seq = out.seq ?? seq;
        const notices: { agentId: string; kind: string }[] = out.notices ?? [];
        if (!notices.length) continue;
        const ids = [...new Set(notices.map(n => n.agentId))];
        const subs = await Promise.all(ids.map(id => api(`/api/agents/${id}`).catch(() => null)));
        const parts = subs.filter(Boolean).map((s: any) => {
          if (s.status === 'waiting') return `### ${s.name} asks\n${s.question}\n\n(answer with message_subagent id="${s.name}"; if it needs the user's decision, ask the user first)`;
          if (s.status === 'done') return `### ${s.name} finished (${s.harness}${s.model ? ` · ${s.model}` : ''}, ${s.elapsed})\n${s.result ?? '(no final message)'}`;
          return `### ${s.name} ${s.status}${s.result ? `\n${s.result}` : ''}`;
        });
        // Only a question wakes pi; finished reports wait for its next turn, so an idle orchestrator spends nothing.
        const asking = subs.some((s: any) => s?.status === 'waiting');
        pi.sendMessage(
          { customType: 'bismind_subagents', content: `Sub-agent update:\n\n${parts.join('\n\n')}`, display: true },
          asking ? { triggerTurn: true, deliverAs: 'steer' } : { deliverAs: 'nextTurn' },
        );
      } catch {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  };
  pi.on('session_start', () => {
    if (running) return;
    running = true;
    void loop();
  });
  pi.on('session_shutdown', () => {
    running = false;
  });

  const Task = Type.Object({
    task: Type.String({ description: 'Complete, self-contained brief: goal, files, constraints, how to verify, what to report. The sub-agent starts with zero context.' }),
    name: Type.Optional(Type.String({ description: 'Short pane name, e.g. "auth-api".' })),
    harness: Type.Optional(Type.String({ description: 'claude | codex | pi | devin — only if the user asked for one.' })),
    model: Type.Optional(Type.String({ description: 'Only if the user asked for a specific model.' })),
    thinking: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    isolate: Type.Optional(Type.Boolean({ description: 'Own git worktree + branch, for parallel edits to one repo.' })),
    issue: Type.Optional(Type.Integer({ minimum: 1, description: 'GitHub issue number. Implies isolate; the sub-agent opens a PR that closes it.' })),
  });

  pi.registerTool({
    name: 'spawn_subagents',
    label: 'Spawn sub-agents',
    description:
      "Start sub-agents in parallel, each in a visible BisMind terminal pane, on the user's sub-agent mode. Returns immediately. A question from a sub-agent arrives as a message and wakes you; finished reports reach you on your next turn. Do NOT poll, sleep, or read their screens in a loop. Put all independent tasks in ONE call.",
    parameters: Type.Object({ tasks: Type.Array(Task, { minItems: 1, maxItems: 12 }), cwd: Type.Optional(Type.String()) }),
    async execute(_id, params: any) {
      const out = await api('/api/subagents', { parentId: AGENT_ID, tasks: params.tasks, cwd: params.cwd ?? process.cwd() }, 120_000);
      return text({ ...out, next: 'Running. End your turn now unless you need their results to continue; a question from one wakes you.' });
    },
  });

  pi.registerTool({
    name: 'wait_subagents',
    label: 'Wait for sub-agents',
    description: 'Block until your sub-agents finish (or any one settles) and return their reports. Use it when you need the results to continue this turn, or when the user says they are done.',
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String())),
      until: Type.Optional(Type.String({ description: 'all | any' })),
      timeout_seconds: Type.Optional(Type.Number()),
    }),
    async execute(_id, params: any) {
      const timeoutMs = Math.round((params.timeout_seconds ?? 900) * 1000);
      return text(await api('/api/wait', { parentId: AGENT_ID, ids: params.ids, until: params.until === 'any' ? 'any' : 'all', timeoutMs }, timeoutMs + 30_000));
    },
  });

  pi.registerTool({
    name: 'message_subagent',
    label: 'Message sub-agent',
    description: 'Send a message to a sub-agent (answer its question, correct course, follow-up task). Its next result is delivered automatically.',
    parameters: Type.Object({ id: Type.String({ description: 'Sub-agent name or id.' }), text: Type.String() }),
    async execute(_id, params: any) {
      await api(`/api/agents/${encodeURIComponent(params.id)}/message`, { text: params.text });
      return text('Delivered.');
    },
  });

  pi.registerTool({
    name: 'read_subagent',
    label: 'Read agent',
    description: "Read any BisMind agent (a sub-agent, or one the user referenced as @bismind:<id>): its task, status, last report and terminal right now. Don't poll.",
    parameters: Type.Object({ id: Type.String(), lines: Type.Optional(Type.Number()) }),
    async execute(_id, params: any) {
      return text(await api(`/api/agents/${encodeURIComponent(params.id)}/read?lines=${params.lines ?? 120}`));
    },
  });

  pi.registerTool({
    name: 'stop_subagent',
    label: 'Stop sub-agent',
    description: 'Stop a sub-agent (its pane stays listed with its result).',
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params: any) {
      await api(`/api/agents/${encodeURIComponent(params.id)}/stop`, {});
      return text('Stopped.');
    },
  });

  pi.registerTool({
    name: 'list_subagents',
    label: 'List sub-agents',
    description: 'List your sub-agents with status and results.',
    parameters: Type.Object({}),
    async execute() {
      return text(await api(`/api/subagents?parent=${AGENT_ID}`));
    },
  });

  pi.registerTool({
    name: 'subagent_mode',
    label: 'Sub-agent mode',
    description: "Show the user's sub-agent mode (harness + model new sub-agents use).",
    parameters: Type.Object({}),
    async execute() {
      return text(await api('/api/mode'));
    },
  });
}
