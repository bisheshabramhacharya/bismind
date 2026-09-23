/**
 * Tiny client for the BisMind server, shared by the CLI, the MCP bridge and the hooks.
 * Starts the server on demand.
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_URL, LOG_PATH, REPO, readToken } from './config.ts';

const TOKEN = readToken();

export async function health(timeoutMs = 800): Promise<{ ok: boolean; pid: number } | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { headers: { 'x-bismind-token': TOKEN }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as { ok: boolean; pid: number }) : null;
  } catch {
    return null;
  }
}

export function startServerDetached() {
  const log = openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, ['--no-warnings', join(REPO, 'server', 'index.ts')], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

let ensured: Promise<void> | null = null;
export function ensureServer(): Promise<void> {
  ensured ??= (async () => {
    if (await health()) return;
    startServerDetached();
    for (let i = 0; i < 40; i += 1) {
      await new Promise(r => setTimeout(r, 250));
      if (await health()) return;
    }
    ensured = null;
    throw new Error(`BisMind server did not start; see ${LOG_PATH}`);
  })();
  return ensured;
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  await ensureServer();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-bismind-token': TOKEN },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text */
  }
  if (!res.ok) throw new Error(data?.error ?? text);
  return data as T;
}
