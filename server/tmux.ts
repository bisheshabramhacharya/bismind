/**
 * Every agent runs inside its own session on a private tmux server (socket "bismind").
 * The agents keep running if BisMind or the browser goes away, and any terminal can
 * attach to them with `bismind attach <name>`.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { TMUX_CONF } from './config.ts';

const SOCKET = process.env.BISMIND_TMUX_SOCKET ?? 'bismind';

const CONF = `# written by BisMind — edits are overwritten on server start
set -g status off
set -g mouse on
set -g history-limit 50000
set -g escape-time 0
set -g focus-events on
set -g extended-keys on
set -g allow-passthrough on
set -g set-clipboard on
set -g remain-on-exit on
set -g window-size latest
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB:extkeys"
set -g detach-on-destroy on
`;

export function tmuxBin(): string | null {
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) if (existsSync(p)) return p;
  try {
    return execFileSync('/bin/sh', ['-lc', 'command -v tmux'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const TMUX = tmuxBin();

export function writeTmuxConf() {
  writeFileSync(TMUX_CONF, CONF);
}

export function baseArgs(): string[] {
  return ['-L', SOCKET, '-f', TMUX_CONF];
}

function run(args: string[], input?: string): Promise<string> {
  if (!TMUX) return Promise.reject(new Error('tmux is not installed (brew install tmux)'));
  return new Promise((resolve, reject) => {
    const child = execFile(TMUX, [...baseArgs(), ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export const tmux = {
  available: Boolean(TMUX),
  bin: TMUX,

  async newSession(name: string, cwd: string, script: string, cols = 160, rows = 48) {
    await run(['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), '-c', cwd, '/bin/sh', script]);
  },

  async sessions(): Promise<Map<string, { dead: boolean; exitCode: number | null; pid: number }>> {
    const out = await run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}']).catch(() => '');
    const map = new Map<string, { dead: boolean; exitCode: number | null; pid: number }>();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [name, dead, status, pid] = line.split('\t');
      map.set(name, { dead: dead === '1', exitCode: status ? Number(status) : null, pid: Number(pid) });
    }
    return map;
  },

  async capture(name: string, lines = 200): Promise<string> {
    const out = await run(['capture-pane', '-p', '-J', '-t', name, '-S', String(-Math.abs(lines))]);
    return out.replace(/\s+$/g, '');
  },

  /** Paste text as one bracketed paste (safe for TUIs and multi-line text), then optionally press Enter. */
  async paste(name: string, text: string, submit = true) {
    const buffer = `bm-${name}-${Date.now()}`;
    await run(['load-buffer', '-b', buffer, '-'], text);
    await run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', name]);
    if (submit) {
      // Give the TUI a beat to absorb the paste before Enter, or some treat it as part of the paste.
      await new Promise(r => setTimeout(r, 180));
      await run(['send-keys', '-t', name, 'Enter']);
    }
  },

  async keys(name: string, ...keys: string[]) {
    await run(['send-keys', '-t', name, ...keys]);
  },

  /** Ask tmux to repaint every client of a session (used when a new viewer attaches). */
  async redraw(name: string) {
    const ttys = await run(['list-clients', '-t', name, '-F', '#{client_tty}']).catch(() => '');
    for (const tty of ttys.split('\n').filter(Boolean)) await run(['refresh-client', '-t', tty]).catch(() => undefined);
  },

  async kill(name: string) {
    await run(['kill-session', '-t', name]).catch(() => undefined);
  },

  /** argv for attaching a real terminal to a session (used by node-pty and `bismind attach`). */
  attachArgv(name: string): { file: string; args: string[] } {
    if (!TMUX) throw new Error('tmux is not installed');
    return { file: TMUX, args: [...baseArgs(), 'attach-session', '-t', name] };
  },
};
