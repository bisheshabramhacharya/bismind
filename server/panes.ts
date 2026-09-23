import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import { resolveSpawn } from './registry.ts';
import type { PaneInfo, PaneStatus } from './types.ts';

const RAW_LIMIT = 512 * 1024;
const PLAIN_LIMIT = 128 * 1024;
const IDLE_AFTER_MS = 1200;

interface PtySession {
  id: string;
  info: PaneInfo;
  proc: pty.IPty;
  raw: string;
  plain: string;
  lastDataAt: number;
  idleTimer: NodeJS.Timeout | null;
  exited: boolean;
}

export interface SpawnRequest {
  cli: string;
  cwd?: string;
  prompt?: string | null;
  title?: string;
  /** auto = headless when the CLI has one, interactive otherwise. */
  mode?: 'auto' | 'interactive' | 'exec';
  /** headed = force the visible TUI even when a headless mode exists. */
  headed?: boolean;
  model?: string | null;
  provider?: string | null;
  args?: string[];
  cols?: number;
  rows?: number;
  parentId?: string | null;
}

export interface WaitOptions {
  until?: 'exit' | 'idle' | 'pattern';
  pattern?: string;
  timeoutMs?: number;
}

export interface WaitResult {
  pane: PaneInfo;
  matched: boolean;
  reason: 'exit' | 'idle' | 'pattern' | 'timeout';
  output: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(input: string): string {
  return input
    .replace(ANSI, '')
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '');
}

function tailLines(text: string, lines: number): string {
  const all = text.split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

export class PaneManager extends EventEmitter {
  private panes = new Map<string, PtySession>();

  list(): PaneInfo[] {
    return [...this.panes.values()].map(p => ({ ...p.info }));
  }

  get(id: string): PaneInfo | null {
    const p = this.panes.get(id);
    return p ? { ...p.info } : null;
  }

  raw(id: string): string {
    return this.panes.get(id)?.raw ?? '';
  }

  output(id: string, lines = 200): string {
    const p = this.panes.get(id);
    if (!p) return '';
    return tailLines(p.plain, lines);
  }

  spawn(req: SpawnRequest): PaneInfo {
    const cwd = req.cwd && existsSync(req.cwd) && statSync(req.cwd).isDirectory() ? req.cwd : homedir();
    const prompt = req.prompt?.trim() ? req.prompt.trim() : null;
    const mode = req.headed ? 'interactive' : req.mode ?? 'auto';
    const resolved = resolveSpawn({
      cliId: req.cli,
      prompt: mode === 'interactive' ? null : prompt,
      args: req.args ?? [],
      cwd,
      model: req.model ?? null,
      provider: req.provider ?? null,
    });
    const id = randomUUID();

    const proc = pty.spawn(resolved.file, resolved.args, {
      name: 'xterm-256color',
      cols: req.cols && req.cols > 10 ? req.cols : 120,
      rows: req.rows && req.rows > 4 ? req.rows : 30,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        BISMIND_PANE_ID: id,
        BISMIND_URL: `http://127.0.0.1:${process.env.BISMIND_PORT ?? 4317}`,
      },
    });

    const now = Date.now();
    const info: PaneInfo = {
      id,
      title: req.title?.trim() || (req.model ? `${resolved.cliLabel} · ${req.model}` : resolved.cliLabel),
      cli: req.cli,
      cliLabel: resolved.cliLabel,
      accent: resolved.accent,
      cwd,
      command: [resolved.file, ...resolved.args].join(' '),
      mode: resolved.mode,
      status: 'starting',
      exitCode: null,
      createdAt: now,
      updatedAt: now,
      parentId: req.parentId ?? null,
      prompt,
      model: req.model ?? null,
      provider: req.provider ?? null,
      headed: resolved.mode !== 'exec',
    };

    const session: PtySession = {
      id,
      info,
      proc,
      raw: '',
      plain: '',
      lastDataAt: now,
      idleTimer: null,
      exited: false,
    };
    this.panes.set(id, session);

    proc.onData(chunk => {
      session.raw = (session.raw + chunk).slice(-RAW_LIMIT);
      session.plain = stripAnsi(session.raw).slice(-PLAIN_LIMIT);
      session.lastDataAt = Date.now();
      if (session.info.status !== 'working') this.setStatus(id, 'working');
      this.armIdle(id);
      this.emit('data', { id, chunk });
      this.checkWaiters(id);
    });

    proc.onExit(({ exitCode }) => {
      session.exited = true;
      session.info.exitCode = exitCode;
      this.setStatus(id, exitCode === 0 ? 'exited' : 'error');
      this.emit('exit', { id, exitCode });
      this.checkWaiters(id);
    });

    // A prompt supplied to a CLI without a headless mode is typed into its TUI.
    if (prompt && resolved.mode === 'interactive') {
      setTimeout(() => {
        try {
          proc.write(prompt.endsWith('\r') ? prompt : `${prompt}\r`);
        } catch {
          /* pane already gone */
        }
      }, 1800);
    }

    this.armIdle(id);
    this.emit('created', { ...info });
    return { ...info };
  }

  private setStatus(id: string, status: PaneStatus) {
    const session = this.panes.get(id);
    if (!session || session.info.status === status) return;
    session.info.status = status;
    session.info.updatedAt = Date.now();
    this.emit('status', { id, status, exitCode: session.info.exitCode });
    this.checkWaiters(id);
  }

  private armIdle(id: string) {
    const session = this.panes.get(id);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.exited) return;
      if (Date.now() - session.lastDataAt >= IDLE_AFTER_MS - 50) this.setStatus(id, 'idle');
    }, IDLE_AFTER_MS);
  }

  write(id: string, data: string) {
    const session = this.panes.get(id);
    if (!session || session.exited) throw new Error(`pane ${id} is not running`);
    session.proc.write(data);
  }

  send(id: string, text: string, submit = true) {
    this.write(id, submit ? `${text.replace(/\r?\n$/, '')}\r` : text);
  }

  resize(id: string, cols: number, rows: number) {
    const session = this.panes.get(id);
    if (!session || session.exited) return;
    try {
      session.proc.resize(Math.max(20, Math.floor(cols)), Math.max(4, Math.floor(rows)));
    } catch {
      /* ignore resize races */
    }
  }

  kill(id: string) {
    const session = this.panes.get(id);
    if (!session) return;
    try {
      session.proc.kill();
    } catch {
      /* already dead */
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.panes.delete(id);
    this.emit('closed', { id });
    this.checkWaiters(id);
  }

  async wait(id: string, opts: WaitOptions = {}): Promise<WaitResult> {
    const session = this.panes.get(id);
    if (!session) throw new Error(`unknown pane ${id}`);
    const until = opts.until ?? 'exit';
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120_000, 250), 30 * 60_000);
    const pattern = opts.pattern;

    const done = (reason: WaitResult['reason'], matched: boolean): WaitResult => ({
      pane: this.get(id) ?? session.info,
      matched,
      reason,
      output: this.output(id, 400),
    });

    const satisfied = (): WaitResult['reason'] | null => {
      if (until === 'exit' && session.exited) return 'exit';
      if (until === 'idle' && !session.exited && session.info.status === 'idle') return 'idle';
      if (until === 'pattern' && pattern && session.plain.includes(pattern)) return 'pattern';
      return null;
    };

    const already = satisfied();
    if (already) return done(already, true);

    return await new Promise<WaitResult>(resolve => {
      const finish = (reason: WaitResult['reason']) => {
        clearTimeout(timer);
        this.off('poll', poll);
        resolve(done(reason, reason !== 'timeout'));
      };
      const poll = (changedId: string) => {
        if (changedId !== id) return;
        const hit = satisfied();
        if (hit) finish(hit);
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      this.on('poll', poll);
    });
  }

  private checkWaiters(id: string) {
    this.emit('poll', id);
  }

  killAll() {
    for (const id of [...this.panes.keys()]) this.kill(id);
  }
}

export const panes = new PaneManager();
