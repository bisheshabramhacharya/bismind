/**
 * Sub-agent orchestration on top of the engine: resolve the sub-agent mode, spawn a
 * batch in parallel, and summarise results for the parent.
 */
import { homedir } from 'node:os';
import { type Agent, agents } from './agents.ts';
import { type HarnessId, describeMode, readSettings } from './config.ts';
import { harnessLabel, harnesses } from './harnesses.ts';

export interface TaskSpec {
  task: string;
  name?: string;
  harness?: HarnessId;
  model?: string;
  thinking?: string;
  cwd?: string;
  isolate?: boolean;
  issue?: number;
}

export async function spawnSubagents(parentId: string | null, tasks: TaskSpec[], cwd?: string) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks must be a non-empty array');
  if (tasks.length > 12) throw new Error('at most 12 sub-agents per call');
  const parent = parentId ? agents.get(parentId) : null;
  const mode = readSettings().mode;
  const defaultHarness: HarnessId = mode.harness === 'native' ? (parent?.harness ?? 'claude') : mode.harness;
  const results = await Promise.allSettled(
    tasks.map(t => {
      if (!t?.task?.trim()) throw new Error('every task needs a "task" brief');
      if (t.issue !== undefined && !(Number.isInteger(t.issue) && t.issue > 0)) throw new Error('issue must be a GitHub issue number');
      const h = t.harness ?? defaultHarness;
      const sameAsMode = !t.harness || t.harness === mode.harness;
      return agents.spawn({
        role: 'sub',
        harness: h,
        model: t.model ?? (sameAsMode ? mode.model : null),
        thinking: t.thinking ?? (sameAsMode ? mode.thinking : null),
        task: t.task,
        name: t.name ?? null,
        cwd: t.cwd ?? cwd ?? parent?.cwd ?? homedir(),
        parentId: parent?.id ?? null,
        // A ticket gets its own branch, so its PR holds only its work.
        isolate: Boolean(t.isolate || t.issue),
        issue: t.issue ?? null,
      });
    }),
  );
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? { ok: true as const, id: r.value.id, name: r.value.name, harness: r.value.harness, model: r.value.model, cwd: r.value.cwd, branch: r.value.worktree?.branch ?? null }
      : { ok: false as const, task: tasks[i].name ?? tasks[i].task.slice(0, 60), error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
  );
}

function elapsed(a: Agent): string {
  const start = a.workStartedAt ?? a.createdAt;
  const end = a.finishedAt ?? Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export async function summarize(a: Agent, withTail: boolean) {
  const base = {
    id: a.id,
    name: a.name,
    harness: harnessLabel(a.harness),
    model: a.model,
    status: a.status,
    elapsed: elapsed(a),
    cwd: a.cwd,
    branch: a.worktree?.branch ?? null,
    question: a.question,
    progress: a.progress,
    result: a.result,
  };
  if (!withTail || ['done', 'waiting'].includes(a.status)) return base;
  const tail = await agents.screen(a.id, 25).catch(() => '');
  return { ...base, recent_screen: tail.split('\n').slice(-25).join('\n') };
}

export async function waitFor(parentId: string | null, ids: string[] | undefined, until: 'all' | 'any', timeoutMs: number) {
  // No ids: your children, or (outside BisMind, no parent) every parentless sub-agent still running.
  const targets = ids?.length
    ? ids.map(id => agents.must(id).id)
    : parentId
      ? agents.children(parentId).map(a => a.id)
      : agents.list().filter(a => a.role === 'sub' && !a.parentId && ['starting', 'working', 'idle'].includes(a.status)).map(a => a.id);
  if (!targets.length) return { timed_out: false, note: 'No sub-agents to wait for.', subagents: [] };
  if (parentId) agents.beginWait(parentId);
  const { timedOut, agents: list } = await agents.wait(targets, until, timeoutMs).finally(() => parentId && agents.endWait(parentId));
  const subagents = await Promise.all(list.map(a => summarize(a, true)));
  const waiting = list.filter(a => a.status === 'waiting');
  const running = list.filter(a => ['starting', 'working', 'idle'].includes(a.status));
  let note = timedOut ? `Timed out with ${running.length} still running. Call wait_subagents again to keep waiting.` : 'Sub-agents settled.';
  if (waiting.length) note += ` ${waiting.map(a => a.name).join(', ')} asked a question: answer with message_subagent, then wait again.`;
  return { timed_out: timedOut, note, subagents };
}

export function modeInfo() {
  const s = readSettings();
  return {
    mode: s.mode,
    description: describeMode(s.mode),
    autonomy: s.autonomy,
    harnesses: harnesses()
      .filter(h => h.id !== 'shell')
      .map(h => ({ id: h.id, label: h.label, installed: Boolean(h.bin) })),
  };
}
