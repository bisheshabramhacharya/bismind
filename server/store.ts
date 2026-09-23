import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BisMindState } from './types.ts';

export const CONFIG_DIR = join(homedir(), '.bismind');
export const STATE_PATH = join(CONFIG_DIR, 'state.json');
export const TOKEN_PATH = join(CONFIG_DIR, 'token');
export const LOG_PATH = join(CONFIG_DIR, 'server.log');

const DEFAULT_STATE: BisMindState = {
  workspaces: [],
  layout: 'stack',
  sidebarHidden: false,
  paneWorkspace: {},
};

export function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function readToken(): string {
  ensureConfigDir();
  if (!existsSync(TOKEN_PATH)) writeFileSync(TOKEN_PATH, randomBytes(24).toString('hex'), { mode: 0o600 });
  return readFileSync(TOKEN_PATH, 'utf8').trim();
}

export function readState(): BisMindState {
  ensureConfigDir();
  if (!existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<BisMindState>;
    return {
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      layout: parsed.layout === 'split' ? 'split' : 'stack',
      sidebarHidden: Boolean(parsed.sidebarHidden),
      paneWorkspace: parsed.paneWorkspace && typeof parsed.paneWorkspace === 'object' ? parsed.paneWorkspace : {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(next: BisMindState) {
  ensureConfigDir();
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
}

export function patchState(patch: Partial<BisMindState>): BisMindState {
  const next = { ...readState(), ...patch };
  writeState(next);
  return next;
}

/** The pane canvas folder registry: a workspace is a real folder agents run in. */
export function addWorkspace(path: string, name?: string) {
  const state = readState();
  const existing = state.workspaces.find(w => w.path === path);
  if (existing) return existing;
  const workspace = {
    id: randomBytes(6).toString('hex'),
    name: name?.trim() || path.split('/').filter(Boolean).pop() || path,
    path,
    createdAt: Date.now(),
  };
  writeState({ ...state, workspaces: [...state.workspaces, workspace] });
  return workspace;
}

export function removeWorkspace(id: string) {
  const state = readState();
  writeState({ ...state, workspaces: state.workspaces.filter(w => w.id !== id) });
}
