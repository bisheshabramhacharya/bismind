/**
 * Paths, token and persisted settings. Everything BisMind keeps on disk lives in ~/.bismind.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = join(REPO, 'bin', 'bismind.mjs');
export const PI_EXTENSION = join(REPO, 'pi-extension', 'bismind.ts');
export const HOME = homedir();
export const DIR = process.env.BISMIND_HOME ?? join(HOME, '.bismind');
export const AGENTS_DIR = join(DIR, 'agents');
export const WORKTREES_DIR = join(DIR, 'worktrees');
export const TOKEN_PATH = join(DIR, 'token');
export const SETTINGS_PATH = join(DIR, 'settings.json');
export const REGISTRY_PATH = join(DIR, 'registry.json');
export const TMUX_CONF = join(DIR, 'tmux.conf');
export const LOG_PATH = join(DIR, 'server.log');
export const PORT = Number(process.env.BISMIND_PORT ?? 4317);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

mkdirSync(AGENTS_DIR, { recursive: true });

export function readToken(): string {
  if (!existsSync(TOKEN_PATH)) writeFileSync(TOKEN_PATH, randomBytes(24).toString('hex'), { mode: 0o600 });
  return readFileSync(TOKEN_PATH, 'utf8').trim();
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write so a crash mid-write never leaves half a file. */
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export type HarnessId = 'claude' | 'codex' | 'pi' | 'devin' | 'shell';

/** How sub-agents get made. `native` means "let the harness use its own sub-agents". */
export interface SubagentMode {
  harness: HarnessId | 'native';
  model: string | null;
  thinking: string | null;
}

/** Who reviews finished sub-agent work. `mode` means "the same as the sub-agent mode". */
export interface ReviewAgent {
  harness: Exclude<HarnessId, 'shell'> | 'mode';
  model: string | null;
  thinking: string | null;
  /** Added to every review brief, e.g. "Use the code-review skill." */
  instructions: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export interface Settings {
  mode: SubagentMode;
  review: ReviewAgent;
  /** full = sub-agents run without permission prompts; ask = they use the harness's normal prompts. */
  autonomy: 'full' | 'ask';
  workspaces: Workspace[];
  activeWorkspace: string | null;
  ui: {
    theme: 'dark' | 'light';
    layout: 'stack' | 'grid' | 'columns';
    showSubagents: boolean;
    rail: boolean;
    dashboard: boolean;
  };
}

const DEFAULT_SETTINGS: Settings = {
  mode: { harness: 'pi', model: 'commandcode/deepseek/deepseek-v4.1-flash', thinking: null },
  review: { harness: 'mode', model: null, thinking: null, instructions: '' },
  autonomy: 'full',
  workspaces: [],
  activeWorkspace: null,
  ui: { theme: 'dark', layout: 'stack', showSubagents: true, rail: true, dashboard: true },
};

export function readSettings(): Settings {
  const s = readJson<Partial<Settings>>(SETTINGS_PATH, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    mode: { ...DEFAULT_SETTINGS.mode, ...(s.mode ?? {}) },
    review: { ...DEFAULT_SETTINGS.review, ...(s.review ?? {}) },
    ui: { ...DEFAULT_SETTINGS.ui, ...(s.ui ?? {}) },
    workspaces: Array.isArray(s.workspaces) ? s.workspaces : [],
  };
}

export function patchSettings(patch: Partial<Settings>): Settings {
  const current = readSettings();
  const next: Settings = {
    ...current,
    ...patch,
    mode: { ...current.mode, ...(patch.mode ?? {}) },
    review: { ...current.review, ...(patch.review ?? {}) },
    ui: { ...current.ui, ...(patch.ui ?? {}) },
  };
  writeJson(SETTINGS_PATH, next);
  return next;
}

export function describeMode(mode: SubagentMode): string {
  if (mode.harness === 'native') return 'native (the harness uses its own sub-agents)';
  return [mode.harness, mode.model ?? 'default model', mode.thinking ? `thinking ${mode.thinking}` : null].filter(Boolean).join(' · ');
}

/** Parse "pi:openai-codex/gpt-5.5:high", "codex:gpt-5.5", "native". */
export function parseModeSpec(spec: string): SubagentMode {
  const trimmed = spec.trim();
  if (trimmed === 'native') return { harness: 'native', model: null, thinking: null };
  const [harness, ...rest] = trimmed.split(':');
  const known = ['claude', 'codex', 'pi', 'devin'];
  if (!known.includes(harness)) throw new Error(`unknown harness "${harness}" (use ${known.join(', ')} or native)`);
  const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  let thinking: string | null = null;
  if (rest.length > 1 && thinkingLevels.includes(rest[rest.length - 1])) thinking = rest.pop() ?? null;
  const model = rest.join(':') || null;
  return { harness: harness as HarnessId, model, thinking };
}
