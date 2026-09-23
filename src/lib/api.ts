export type PaneStatus = 'starting' | 'working' | 'idle' | 'exited' | 'error';

export interface Pane {
  id: string;
  title: string;
  cli: string;
  cliLabel: string;
  accent: string;
  cwd: string;
  status: PaneStatus;
  mode: 'interactive' | 'exec' | 'shell';
  exitCode: number | null;
  parentId: string | null;
  prompt: string | null;
  model: string | null;
  provider: string | null;
  headed: boolean;
  command: string;
  createdAt: number;
}

export interface Cli {
  id: string;
  label: string;
  available: boolean;
  bin: string | null;
  accent: string;
  hint: string;
  interactiveOnly: boolean;
  custom: boolean;
  providers?: string[];
  modelArg?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export interface CanvasState {
  workspaces: Workspace[];
  layout: 'stack' | 'split';
  sidebarHidden: boolean;
  paneWorkspace: Record<string, string>;
}

export interface SpawnRequest {
  cli: string;
  prompt?: string | null;
  cwd?: string;
  title?: string;
  headed?: boolean;
  model?: string | null;
  provider?: string | null;
  args?: string[];
  parentId?: string | null;
  cols?: number;
  rows?: number;
}

export interface HelloFrame {
  type: 'hello';
  panes: Pane[];
  state: CanvasState;
}

type Frame =
  | HelloFrame
  | { type: 'snapshot'; paneId: string; data: string }
  | { type: 'data'; paneId: string; data: string }
  | { type: 'status'; paneId: string; status: PaneStatus; exitCode: number | null }
  | { type: 'created'; pane: Pane }
  | { type: 'closed'; paneId: string };

export function resolveToken(): string {
  const injected = (window as unknown as { __BISMIND_TOKEN__?: string }).__BISMIND_TOKEN__;
  const fromUrl = new URLSearchParams(window.location.search).get('t');
  const stored = window.localStorage.getItem('bismind.token');
  const token = injected ?? fromUrl ?? stored ?? '';
  if (token) window.localStorage.setItem('bismind.token', token);
  return token;
}

const TOKEN = resolveToken();

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-bismind-token': TOKEN },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `request failed (${res.status})`);
  return parsed;
}

export class CanvasSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<(frame: Frame) => void>();
  private queue: string[] = [];
  private retry = 0;

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const frame of this.queue.splice(0)) ws.send(frame);
    };
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data)) as Frame;
      for (const listener of this.listeners) listener(frame);
    };
    ws.onclose = () => {
      this.ws = null;
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(), 300 * this.retry);
    };
  }

  onFrame(listener: (frame: Frame) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(frame: Record<string, unknown>) {
    const text = JSON.stringify(frame);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
  }

  attach(paneId: string, cols: number, rows: number) {
    this.send({ type: 'attach', paneId, cols, rows });
  }
  detach(paneId: string) {
    this.send({ type: 'detach', paneId });
  }
  input(paneId: string, data: string) {
    this.send({ type: 'input', paneId, data });
  }
  resize(paneId: string, cols: number, rows: number) {
    this.send({ type: 'resize', paneId, cols, rows });
  }
}

export const socket = new CanvasSocket();
