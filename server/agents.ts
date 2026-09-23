/**
 * The agent engine. An agent is one harness running in one tmux session. Main agents
 * are the ones you talk to; sub-agents are spawned by a main agent through BisMind and
 * report back when their turn ends.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as pty from 'node-pty';
import { AGENTS_DIR, REGISTRY_PATH, WORKTREES_DIR, type HarnessId, readJson, readSettings, writeJson } from './config.ts';
import { harness, harnessLabel, harnesses, writeLaunch } from './harnesses.ts';
import { tmux } from './tmux.ts';

export type AgentStatus = 'starting' | 'working' | 'idle' | 'done' | 'waiting' | 'exited' | 'error';

export interface Agent {
  id: string;
  name: string;
  harness: HarnessId;
  model: string | null;
  thinking: string | null;
  cwd: string;
  workspaceId: string | null;
  role: 'main' | 'sub';
  parentId: string | null;
  task: string | null;
  status: AgentStatus;
  result: string | null;
  question: string | null;
  /** Latest one-line progress note from the sub-agent. */
  progress: string | null;
  exitCode: number | null;
  turns: number;
  createdAt: number;
  updatedAt: number;
  workStartedAt: number | null;
  finishedAt: number | null;
  /** `base`: the commit the branch started from (missing on agents made before it was recorded). */
  worktree: { path: string; branch: string; repo: string; base?: string } | null;
  /** GitHub issue this sub-agent works on. */
  issue?: number | null;
  /** For a review sub-agent: the id of the sub-agent whose work it reviews. */
  reviewOf?: string | null;
  session: string;
}

export interface SpawnInput {
  harness: HarnessId;
  cwd: string;
  role?: 'main' | 'sub';
  model?: string | null;
  thinking?: string | null;
  name?: string | null;
  task?: string | null;
  parentId?: string | null;
  workspaceId?: string | null;
  isolate?: boolean;
  /** GitHub issue this sub-agent works on; it opens a PR that closes it. */
  issue?: number | null;
  reviewOf?: string | null;
  cols?: number;
  rows?: number;
}

export interface Notice {
  seq: number;
  parentId: string | null;
  agentId: string;
  kind: 'done' | 'question' | 'exited';
  at: number;
}

const SETTLED: AgentStatus[] = ['done', 'waiting', 'exited', 'error'];
const IDLE_AFTER_MS = 2500;
/** Devin has no turn hook and finishes with `bismind done`; if it forgets, call its turn over after this long without output. */
const DEVIN_DONE_AFTER_MS = 45_000;
/** Any sub-agent silent this long is stalled (crashed, errored, or stuck on a prompt). Live TUIs redraw timers every second. */
const STALL_AFTER_MS = 90_000;
const RING_LIMIT = 400 * 1024;

interface Live {
  proc: pty.IPty | null;
  ring: string;
  lastOutputAt: number;
  /** Output after a settle only counts as work again once the agent is told to go. */
  settledAt: number;
  cols: number;
  rows: number;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', cwd, ...args], (err, out, errOut) => (err ? reject(new Error(errOut.trim() || err.message)) : resolve(out.trim()))),
  );
}

function slug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !['the', 'a', 'an', 'and', 'to', 'of', 'in', 'for', 'on', 'with', 'you', 'your', 'please'].includes(w));
  return words.slice(0, 3).join('-').slice(0, 24) || 'task';
}

export class Agents extends EventEmitter {
  private agents = new Map<string, Agent>();
  private live = new Map<string, Live>();
  private notices: Notice[] = [];
  private seq = 0;
  private tick: NodeJS.Timeout | null = null;
  /** Parents currently blocked in wait_subagents (they'll see results without a nudge). */
  private activeWaits = new Map<string, number>();
  /** Parents with sub-agent news they haven't seen yet. */
  private pendingWake = new Set<string>();
  private wakeTimers = new Map<string, NodeJS.Timeout>();
  private lastInputAt = new Map<string, number>();
  /** Names picked by spawns that are still starting. */
  private reserved = new Set<string>();

  async start() {
    for (const a of readJson<Agent[]>(REGISTRY_PATH, [])) this.agents.set(a.id, a);
    await this.reconcile();
    for (const a of this.agents.values()) if (!['exited', 'error'].includes(a.status)) this.attach(a.id);
    this.tick = setInterval(() => this.onTick(), 1000);
    setInterval(() => this.reconcile().catch(err => console.error('[agents] reconcile failed', err)), 4000);
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(idOrName: string): Agent | null {
    return this.agents.get(idOrName) ?? this.list().find(a => a.name === idOrName) ?? null;
  }

  must(idOrName: string): Agent {
    const a = this.get(idOrName);
    if (!a) throw new Error(`no agent "${idOrName}"`);
    return a;
  }

  children(parentId: string): Agent[] {
    return this.list().filter(a => a.parentId === parentId);
  }

  private save() {
    // A full disk or bad permissions must not take the server (and every agent's bookkeeping) down.
    try {
      writeJson(REGISTRY_PATH, this.list());
    } catch (err) {
      console.error('[agents] could not save the registry', err);
    }
  }

  private update(id: string, patch: Partial<Agent>) {
    const a = this.agents.get(id);
    if (!a) return;
    Object.assign(a, patch, { updatedAt: Date.now() });
    this.save();
    this.emit('agent', { ...a });
  }

  private setStatus(id: string, status: AgentStatus, patch: Partial<Agent> = {}) {
    const a = this.agents.get(id);
    if (!a) return;
    if (a.status === status && Object.keys(patch).length === 0) return;
    const becameWorking = status === 'working' && a.status !== 'working';
    this.update(id, { ...patch, status, ...(becameWorking ? { workStartedAt: Date.now(), finishedAt: null } : {}) });
    if (SETTLED.includes(status)) {
      const live = this.live.get(id);
      if (live) live.settledAt = Date.now();
    }
  }

  private notify(agent: Agent, kind: Notice['kind']) {
    this.notices.push({ seq: ++this.seq, parentId: agent.parentId, agentId: agent.id, kind, at: Date.now() });
    if (this.notices.length > 500) this.notices.splice(0, this.notices.length - 500);
    this.emit('notice');
    // Only questions wake the parent. Finished work waits until the parent (or the user) asks for it.
    if (agent.parentId && kind === 'question') {
      this.pendingWake.add(agent.parentId);
      this.scheduleWake(agent.parentId, 2000);
    }
  }

  // ─── Waking parents ───────────────────────────────────────────────────────────────
  // A parent that ended its turn is woken only when a sub-agent asks a question, so an idle
  // orchestrator spends no tokens while its sub-agents work. pi gets the question pushed by its
  // extension; for Claude Code and Codex, type a short notice into the pane.

  beginWait(parentId: string) {
    this.activeWaits.set(parentId, (this.activeWaits.get(parentId) ?? 0) + 1);
  }

  /** `delivered`: the wait returned its results. An aborted wait delivered nothing, so a pending wake still stands. */
  endWait(parentId: string, delivered = true) {
    const n = (this.activeWaits.get(parentId) ?? 1) - 1;
    if (n <= 0) this.activeWaits.delete(parentId);
    else this.activeWaits.set(parentId, n);
    if (delivered) this.pendingWake.delete(parentId);
    else if (this.pendingWake.has(parentId)) this.scheduleWake(parentId, 1500);
  }

  private scheduleWake(parentId: string, delay: number) {
    clearTimeout(this.wakeTimers.get(parentId));
    this.wakeTimers.set(parentId, setTimeout(() => this.wake(parentId).catch(err => console.error('[agents] wake failed', err)), delay));
  }

  private async wake(parentId: string) {
    this.wakeTimers.delete(parentId);
    const p = this.agents.get(parentId);
    if (!p || !this.pendingWake.has(parentId) || this.activeWaits.get(parentId)) return;
    if (p.harness !== 'claude' && p.harness !== 'codex') return;
    if (p.status !== 'idle') return; // re-checked when its turn ends
    // Don't type over the human.
    if (Date.now() - (this.lastInputAt.get(parentId) ?? 0) < 15_000) return this.scheduleWake(parentId, 8000);
    const kids = this.children(parentId);
    const asking = kids.filter(k => k.status === 'waiting').map(k => k.name);
    const done = kids.filter(k => ['done', 'exited', 'error'].includes(k.status)).map(k => k.name);
    const running = kids.filter(k => ['starting', 'working'].includes(k.status)).length;
    this.pendingWake.delete(parentId);
    if (!asking.length) return; // answered already
    const parts = [
      `${asking.join(', ')} asked you a question`,
      done.length ? `${done.join(', ')} finished` : null,
      running ? `${running} still running` : null,
    ].filter(Boolean);
    const text = `[BisMind] Sub-agent update: ${parts.join('; ')}. Read the question with list_subagents and answer it with message_subagent (ask me first if it needs my decision). Then end your turn; don't wait on the others.`;
    await tmux.paste(p.session, text, true).catch(() => undefined);
    this.setStatus(parentId, 'working');
  }

  private uniqueName(base: string): string {
    const taken = new Set([...this.list().map(a => a.name), ...this.reserved]);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  async spawn(input: SpawnInput): Promise<Agent> {
    const role = input.role ?? 'main';
    const h = harness(input.harness);
    if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw new Error(`folder does not exist: ${input.cwd}`);
    const parent = input.parentId ? this.agents.get(input.parentId) ?? null : null;
    const id = randomBytes(3).toString('hex');
    // Reserved until the agent is registered, so parallel spawns never pick the same name.
    const name = this.uniqueName(input.name?.trim() ? slug(input.name) : role === 'sub' && input.task ? slug(input.task) : h.id === 'shell' ? 'terminal' : h.id);
    this.reserved.add(name);
    const agentDir = join(AGENTS_DIR, id);
    mkdirSync(agentDir, { recursive: true });

    let cwd = input.cwd;
    let worktree: Agent['worktree'] = null;
    try {
      if (input.isolate) {
        const repo = await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => null);
        if (!repo) throw new Error(`isolate needs a git repo, and ${cwd} is not in one`);
        const branch = `bismind/${name}-${id}`;
        const path = join(WORKTREES_DIR, id);
        mkdirSync(WORKTREES_DIR, { recursive: true });
        const base = await git(repo, ['rev-parse', 'HEAD']);
        await git(repo, ['worktree', 'add', '-b', branch, path, base]);
        worktree = { path, branch, repo, base };
        cwd = join(path, relative(repo, input.cwd));
      }

      const settings = readSettings();
      const now = Date.now();
      const agent: Agent = {
        id,
        name,
        harness: h.id,
        model: input.model ?? null,
        thinking: input.thinking ?? null,
        cwd,
        workspaceId: input.workspaceId ?? parent?.workspaceId ?? null,
        role,
        parentId: parent?.id ?? null,
        task: input.task ?? null,
        status: 'starting',
        result: null,
        question: null,
        progress: null,
        exitCode: null,
        turns: 0,
        createdAt: now,
        updatedAt: now,
        workStartedAt: role === 'sub' ? now : null,
        finishedAt: null,
        worktree,
        issue: input.issue ?? null,
        reviewOf: input.reviewOf ?? null,
        session: `bm-${id}`,
      };

      const script = writeLaunch({
        id,
        name,
        harness: h.id,
        role,
        cwd,
        model: agent.model,
        thinking: agent.thinking,
        task: agent.task,
        parentLabel: parent ? `${parent.name}, running ${harnessLabel(parent.harness)}` : null,
        worktree,
        issue: input.issue ?? null,
        agentDir,
        orchestrate: settings.mode.harness !== 'native',
      });

      const cols = input.cols ?? 160;
      const rows = input.rows ?? 48;
      await tmux.newSession(agent.session, cwd, script, cols, rows);
      this.agents.set(id, agent);
      this.save();
      this.attach(id, cols, rows);
      this.emit('agent', { ...agent });
      // The user picked this folder (a workspace, or a parent's cwd), so accept first-run trust gates.
      void this.autoTrust(id);
      return { ...agent };
    } catch (err) {
      // Don't leave a half-made agent behind in the user's repo.
      rmSync(agentDir, { recursive: true, force: true });
      const w = worktree as Agent['worktree'];
      if (w) await git(w.repo, ['worktree', 'remove', '--force', w.path]).then(() => git(w.repo, ['branch', '-D', w.branch])).catch(() => undefined);
      throw err;
    } finally {
      this.reserved.delete(name);
    }
  }

  /** Sub-agents open in folders the harness may never have seen; accept its "trust this folder?" gate. */
  private async autoTrust(id: string) {
    for (let i = 0; i < 12; i += 1) {
      await new Promise(r => setTimeout(r, 1500));
      const a = this.agents.get(id);
      if (!a || SETTLED.includes(a.status)) return;
      const screen = await tmux.capture(a.session, 40).catch(() => '');
      if (!/do you trust|trust (the files in )?this folder|allow codex to work in this folder|trust this (project|workspace|directory)|one you trust/i.test(screen)) continue;
      // Menus differ (Claude defaults to "No, exit"), so move the cursor onto the yes/trust option first.
      const lines = screen.split('\n');
      const options = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*(❯|›|>)?\s*(\d+\.\s*)?(yes|no|allow|trust|don't|do not|quit|exit)/i.test(l));
      const cursor = options.findIndex(({ l }) => /^\s*(❯|›|>)/.test(l));
      const yes = options.findIndex(({ l }) => /\b(yes|allow)\b/i.test(l) && !/\bno\b/i.test(l));
      if (yes < 0) {
        // Single-line menus ("❭ 1 Yes, trust · 2 No, exit"): press the yes option's number.
        const digit = screen.match(/(\d)[.)]?\s+(yes|allow)\b/i)?.[1];
        if (digit) await tmux.keys(a.session, digit).catch(() => undefined);
        return;
      }
      const delta = yes - Math.max(cursor, 0);
      for (let k = 0; k < Math.abs(delta); k += 1) await tmux.keys(a.session, delta > 0 ? 'Down' : 'Up').catch(() => undefined);
      await tmux.keys(a.session, 'Enter').catch(() => undefined);
      return;
    }
  }

  /** One node-pty client per agent attached to its tmux session; the browser views stream through it. */
  attach(id: string, cols = 160, rows = 48) {
    const a = this.agents.get(id);
    if (!a || this.live.get(id)?.proc) return;
    const live: Live = this.live.get(id) ?? { proc: null, ring: '', lastOutputAt: 0, settledAt: 0, cols, rows };
    this.live.set(id, live);
    const { file, args } = tmux.attachArgv(a.session);
    let proc: pty.IPty;
    try {
      proc = pty.spawn(file, args, { name: 'xterm-256color', cols: live.cols, rows: live.rows, cwd: a.cwd, env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string> });
    } catch (err) {
      console.error(`[agents] attach ${a.name} failed`, err); // onTick retries
      return;
    }
    live.proc = proc;
    proc.onData(chunk => {
      live.ring = (live.ring + chunk).slice(-RING_LIMIT);
      live.lastOutputAt = Date.now();
      this.emit('data', { id, chunk });
    });
    proc.onExit(() => {
      live.proc = null;
    });
  }

  snapshot(id: string): string {
    return this.live.get(id)?.ring ?? '';
  }

  write(id: string, data: string) {
    const a = this.agents.get(id);
    const live = this.live.get(id);
    if (!a || !live?.proc) return;
    live.proc.write(data);
    this.lastInputAt.set(id, Date.now());
    // A human pressing Enter in a settled agent's pane starts a new turn.
    if (data.includes('\r') && ['done', 'idle', 'waiting'].includes(a.status)) this.setStatus(id, 'working', { question: null });
  }

  resize(id: string, cols: number, rows: number) {
    const live = this.live.get(id);
    if (!live) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    // A tiny or hidden viewer must not squash the agent's real terminal (TUIs break below this).
    live.cols = Math.max(60, Math.floor(cols));
    live.rows = Math.max(15, Math.floor(rows));
    try {
      live.proc?.resize(live.cols, live.rows);
    } catch {
      /* resize race with exit */
    }
  }

  async screen(idOrName: string, lines = 120): Promise<string> {
    const a = this.must(idOrName);
    return tmux.capture(a.session, lines).catch(() => this.snapshot(a.id).slice(-4000));
  }

  async message(idOrName: string, text: string) {
    const a = this.must(idOrName);
    if (['exited', 'error'].includes(a.status)) throw new Error(`${a.name} has exited; spawn a new sub-agent instead`);
    await tmux.paste(a.session, text, true);
    this.setStatus(a.id, 'working', { question: null });
  }

  async kill(idOrName: string) {
    const a = this.must(idOrName);
    // Closing an agent closes its whole team, newest first (reviewers before the workers they review).
    for (const child of this.children(a.id).reverse()) await this.kill(child.id);
    await tmux.kill(a.session);
    this.live.get(a.id)?.proc?.kill();
    this.live.delete(a.id);
    this.agents.delete(a.id);
    rmSync(join(AGENTS_DIR, a.id), { recursive: true, force: true });
    this.save();
    this.emit('removed', { id: a.id });
    // Drop its worktree folder but keep the branch (and its commits). Git refuses when there are
    // uncommitted changes, which is what we want; skip it while another agent (a reviewer) works there.
    const w = a.worktree;
    if (w && !this.list().some(o => o.cwd === w.path || o.cwd.startsWith(`${w.path}/`))) await git(w.repo, ['worktree', 'remove', w.path]).catch(() => undefined);
  }

  /** Stop the process but keep the agent (and its result) listed. */
  async stop(idOrName: string) {
    const a = this.must(idOrName);
    await tmux.kill(a.session);
    this.live.get(a.id)?.proc?.kill();
    this.setStatus(a.id, 'exited', { finishedAt: Date.now() });
  }

  // ─── Signals from hooks / extensions / the `bismind ask` shim ───────────────────────

  turnStarted(id: string) {
    const a = this.agents.get(id);
    if (a && a.status !== 'working') this.setStatus(id, 'working', a.status === 'waiting' ? {} : { question: null });
  }

  turnEnded(id: string, message: string | null) {
    const a = this.agents.get(id);
    if (!a) return;
    const result = message?.trim() || a.result;
    const turns = a.turns + 1;
    if (a.question) {
      this.setStatus(id, 'waiting', { result, turns });
      return;
    }
    this.setStatus(id, a.role === 'sub' ? 'done' : 'idle', { result, turns, finishedAt: Date.now(), progress: null });
    if (a.role === 'sub') this.notify(this.agents.get(id)!, 'done');
    else if (this.pendingWake.has(id)) this.scheduleWake(id, 1500);
  }

  /** A sub-agent's explicit report (`bismind done`), for harnesses without a turn hook. */
  finish(id: string, report: string) {
    const a = this.agents.get(id);
    if (!a) throw new Error(`no agent ${id}`);
    if (a.role !== 'sub' || ['exited', 'error'].includes(a.status)) throw new Error('only a running sub-agent can hand in a report');
    // The idle fallback may have settled it already: the real report replaces the screen capture, never a real report.
    if (a.status === 'done') {
      if (a.result?.startsWith('[BisMind:')) this.update(id, { result: report });
      return;
    }
    this.update(id, { question: null });
    this.turnEnded(id, report);
  }

  progress(id: string, note: string) {
    if (this.agents.has(id)) this.update(id, { progress: note.slice(0, 200) });
  }

  ask(id: string, question: string) {
    const a = this.agents.get(id);
    if (!a) throw new Error(`no agent ${id}`);
    if (a.role !== 'sub' || ['exited', 'error'].includes(a.status)) throw new Error('only a running sub-agent can ask its parent');
    this.setStatus(id, 'waiting', { question });
    this.notify(this.agents.get(id)!, 'question');
  }

  // ─── Waiting ─────────────────────────────────────────────────────────────────────

  /** Resolve when `until` is met for `ids`: all settled, or any settled. */
  wait(ids: string[], until: 'all' | 'any', timeoutMs: number, signal?: AbortSignal): Promise<{ timedOut: boolean; agents: Agent[] }> {
    const check = () => {
      const agents = ids.map(id => this.agents.get(id)).filter((a): a is Agent => Boolean(a));
      const settled = agents.filter(a => SETTLED.includes(a.status));
      const ok = agents.length === 0 || (until === 'all' ? settled.length === agents.length : settled.length > 0);
      return ok ? agents : null;
    };
    const now = check();
    if (now) return Promise.resolve({ timedOut: false, agents: now.map(a => ({ ...a })) });
    return new Promise(resolve => {
      const onChange = () => {
        const hit = check();
        if (hit) finish(false, hit);
      };
      const finish = (timedOut: boolean, agents?: Agent[]) => {
        clearTimeout(timer);
        this.off('agent', onChange);
        this.off('removed', onChange);
        const list = agents ?? ids.map(id => this.agents.get(id)).filter((a): a is Agent => Boolean(a));
        resolve({ timedOut, agents: list.map(a => ({ ...a })) });
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      this.on('agent', onChange);
      this.on('removed', onChange);
      signal?.addEventListener('abort', () => finish(true), { once: true });
    });
  }

  /** Long-poll for notices addressed to a parent (the pi extension uses this to get results pushed). */
  noticesFor(parentId: string, after: number, timeoutMs: number): Promise<{ seq: number; notices: Notice[] }> {
    const pick = () => this.notices.filter(n => n.parentId === parentId && n.seq > after);
    const found = pick();
    if (found.length) return Promise.resolve({ seq: this.seq, notices: found });
    return new Promise(resolve => {
      const onNotice = () => {
        const hit = pick();
        if (hit.length) finish(hit);
      };
      const finish = (list: Notice[]) => {
        clearTimeout(timer);
        this.off('notice', onNotice);
        resolve({ seq: this.seq, notices: list });
      };
      const timer = setTimeout(() => finish([]), timeoutMs);
      this.on('notice', onNotice);
    });
  }

  // ─── Status bookkeeping ───────────────────────────────────────────────────────────

  private onTick() {
    try {
      this.tickOnce();
    } catch (err) {
      console.error('[agents] tick failed', err);
    }
  }

  private tickOnce() {
    const now = Date.now();
    for (const a of this.agents.values()) {
      if (['exited', 'error'].includes(a.status)) continue;
      const live = this.live.get(a.id);
      // No terminal client (e.g. pty.spawn failed): keep trying, or the agent never leaves "starting".
      if (!live?.proc) {
        this.attach(a.id);
        continue;
      }
      const active = now - live.lastOutputAt < IDLE_AFTER_MS;
      const reportsTurns = harnesses().find(h => h.id === a.harness)?.reportsTurns ?? false;
      if (a.status === 'starting' && live.lastOutputAt) {
        this.setStatus(a.id, a.role === 'sub' ? 'working' : 'idle');
        continue;
      }
      if (a.role === 'sub' && a.status === 'working' && live.lastOutputAt && now - live.lastOutputAt >= STALL_AFTER_MS) {
        this.settleFromScreen(a.id, true).catch(err => console.error('[agents] settle failed', err));
        continue;
      }
      // Hook-reporting harnesses change state only on real signals (turn hooks, Enter, messages);
      // screen activity alone (resizes, redraws) would lie.
      if (reportsTurns) continue;
      // Devin and shells: no hook, so read activity.
      if (a.status === 'working' && !active) {
        if (a.role === 'sub' && a.harness === 'devin') {
          const started = now - (a.workStartedAt ?? a.createdAt) > 20_000;
          if (started && now - live.lastOutputAt >= DEVIN_DONE_AFTER_MS) this.settleFromScreen(a.id).catch(err => console.error('[agents] settle failed', err));
        } else this.setStatus(a.id, 'idle');
      } else if (a.status === 'idle' && active) this.setStatus(a.id, 'working');
    }
  }

  private async settleFromScreen(id: string, stalled = false) {
    const a = this.agents.get(id);
    if (!a || a.status !== 'working') return;
    const screen = (await tmux.capture(a.session, 60).catch(() => '')).split('\n').slice(-40).join('\n').trim();
    // A real signal (turn hook, `bismind done`) may have landed while the screen was captured.
    if (this.agents.get(id)?.status !== 'working') return;
    const note = stalled
      ? `[BisMind: no activity for ${STALL_AFTER_MS / 1000}s, so this sub-agent may have errored or be stuck on a prompt. Its screen:]\n`
      : `[BisMind: ${harnessLabel(a.harness)} has no finish signal; this is the end of its screen:]\n`;
    this.turnEnded(id, note + screen);
  }

  private async reconcile() {
    const sessions = await tmux.sessions();
    for (const a of [...this.agents.values()]) {
      const s = sessions.get(a.session);
      if (!s) {
        if (!['exited', 'error'].includes(a.status)) {
          this.setStatus(a.id, 'exited', { finishedAt: Date.now() });
          if (a.role === 'sub') this.notify(a, 'exited');
        }
        continue;
      }
      if (s.dead && !['exited', 'error'].includes(a.status)) {
        this.setStatus(a.id, s.exitCode ? 'error' : 'exited', { exitCode: s.exitCode, finishedAt: Date.now() });
        if (a.role === 'sub') this.notify(this.agents.get(a.id)!, 'exited');
      }
    }
  }

  readPrompt(id: string): string | null {
    const p = join(AGENTS_DIR, id, 'prompt.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
}

export const agents = new Agents();
