/**
 * One WebSocket to the BisMind server carries state pushes and terminal streams.
 * Components read state with useStore(); terminals subscribe per agent.
 */
import { useRef, useSyncExternalStore } from 'react';
import type { Agent, HarnessInfo, ModeInfo, Settings } from './types';

const params = new URLSearchParams(location.search);
const fromUrl = params.get('t');
if (fromUrl) {
  sessionStorage.setItem('bismind-token', fromUrl);
  try {
    localStorage.setItem('bismind-token', fromUrl);
  } catch {
    /* storage blocked */
  }
  history.replaceState(null, '', location.pathname);
}
export const TOKEN = fromUrl ?? sessionStorage.getItem('bismind-token') ?? localStorage.getItem('bismind-token') ?? '';

export interface State {
  connected: boolean;
  loaded: boolean;
  agents: Agent[];
  settings: Settings | null;
  harnesses: HarnessInfo[];
  mode: ModeInfo | null;
  home: string;
  focusedId: string | null;
  maximizedId: string | null;
  /** Sub-agents the user opened while sub-agents are hidden. */
  peeked: string[];
  seen: Record<string, number>;
}

let state: State = {
  connected: false,
  loaded: false,
  agents: [],
  settings: null,
  harnesses: [],
  mode: null,
  home: '',
  focusedId: null,
  maximizedId: null,
  peeked: [],
  seen: {},
};

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  emit();
}
export function getState() {
  return state;
}
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => Object.is(x, b[i]));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Selectors may derive arrays (e.g. filter agents); equal results keep the same reference so React doesn't loop. */
export function useStore<T>(select: (s: State) => T): T {
  const last = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const value = select(state);
    if (last.current && shallowEqual(last.current.value, value)) return last.current.value;
    last.current = { value };
    return value;
  });
}

// ─── REST ─────────────────────────────────────────────────────────────────────────

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-bismind-token': TOKEN },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data as T;
}

export async function patchSettings(patch: Record<string, unknown>) {
  const out = await api<{ settings: Settings; mode: ModeInfo }>('/api/settings', { method: 'PATCH', body: patch });
  setState({ settings: out.settings, mode: out.mode });
}

export function patchUi(patch: Partial<Settings['ui']>) {
  const s = state.settings;
  if (!s) return;
  setState({ settings: { ...s, ui: { ...s.ui, ...patch } } });
  void patchSettings({ ui: { ...s.ui, ...patch } });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────────

type DataSink = { write: (data: string) => void; reset: (snapshot: string) => void };
const sinks = new Map<string, Set<DataSink>>();
let ws: WebSocket | null = null;
let retry = 0;

function wsSend(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function upsert(agent: Agent) {
  setState(s => {
    const i = s.agents.findIndex(a => a.id === agent.id);
    const agents = i >= 0 ? s.agents.map(a => (a.id === agent.id ? agent : a)) : [...s.agents, agent];
    return { agents };
  });
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => {
    retry = 0;
    setState({ connected: true });
  };
  ws.onclose = () => {
    setState({ connected: false });
    setTimeout(connect, Math.min(4000, 400 * 2 ** retry++));
  };
  ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data));
    switch (msg.type) {
      case 'state':
        setState({ loaded: true, agents: msg.agents, settings: msg.settings, harnesses: msg.harnesses, mode: msg.mode, home: msg.home });
        // Re-attach every terminal that is on screen after a reconnect.
        for (const id of sinks.keys()) wsSend({ type: 'attach', id });
        break;
      case 'settings':
        setState({ settings: msg.settings, mode: msg.mode });
        break;
      case 'agent':
        upsert(msg.agent);
        break;
      case 'removed':
        setState(s => ({
          agents: s.agents.filter(a => a.id !== msg.id),
          focusedId: s.focusedId === msg.id ? null : s.focusedId,
          maximizedId: s.maximizedId === msg.id ? null : s.maximizedId,
        }));
        break;
      case 'data':
        for (const sink of sinks.get(msg.id) ?? []) sink.write(msg.data);
        break;
      case 'snapshot':
        for (const sink of sinks.get(msg.id) ?? []) sink.reset(msg.data);
        break;
    }
  };
}

export const term = {
  attach(id: string, sink: DataSink, cols: number, rows: number) {
    let set = sinks.get(id);
    if (!set) sinks.set(id, (set = new Set()));
    set.add(sink);
    wsSend({ type: 'attach', id, cols, rows });
    return () => {
      set!.delete(sink);
      if (!set!.size) {
        sinks.delete(id);
        wsSend({ type: 'detach', id });
      }
    };
  },
  input(id: string, data: string) {
    wsSend({ type: 'input', id, data });
  },
  resize(id: string, cols: number, rows: number) {
    wsSend({ type: 'resize', id, cols, rows });
  },
};

// ─── helpers ──────────────────────────────────────────────────────────────────────

export function tildify(path: string, home = state.home): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function elapsed(a: Agent, now = Date.now()): string {
  const start = a.workStartedAt ?? a.createdAt;
  const end = ['done', 'waiting', 'idle', 'exited', 'error'].includes(a.status) ? (a.finishedAt ?? a.updatedAt) : now;
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function shortModel(model: string | null): string | null {
  if (!model) return null;
  const last = model.split('/').pop() ?? model;
  return last;
}
