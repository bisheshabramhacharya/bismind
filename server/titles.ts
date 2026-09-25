/**
 * Short chat titles for the rail, written by GPT-5.6 Luna on the school ChatGPT account.
 * pi runs against its own config dir holding only that login, so the user's active pi account is untouched.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, HOME, readJson, writeJson } from './config.ts';

const PI_DIR = join(DIR, 'pi-school');
const AUTH = join(PI_DIR, 'auth.json');
const SCHOOL = join(HOME, '.pi', 'agent', 'accounts', 'school.json');

type Cred = { expires?: number };

/** Credentials stay owner-only. */
function writeSecret(path: string, value: unknown) {
  writeJson(path, value);
  chmodSync(path, 0o600);
}

/** OAuth refresh tokens rotate: keep whichever copy is newer in both places. */
function syncCredentials() {
  if (!existsSync(SCHOOL)) return false;
  mkdirSync(PI_DIR, { recursive: true });
  const school = readJson<Cred>(SCHOOL, {});
  const ours = readJson<{ 'openai-codex'?: Cred }>(AUTH, {})['openai-codex'];
  if (!ours || (school.expires ?? 0) > (ours.expires ?? 0)) writeSecret(AUTH, { 'openai-codex': school });
  else if ((ours.expires ?? 0) > (school.expires ?? 0)) writeSecret(SCHOOL, ours);
  return true;
}

export function generateTitle(prompt: string): Promise<string | null> {
  if (!syncCredentials()) return Promise.resolve(null);
  const ask = `Write a 2-5 word title for the coding-agent chat below (it may be a raw terminal capture; ignore banners and UI chrome and name what the user asked for; if nothing was asked yet, reply New chat). Reply with the title only: no quotes, no trailing period.\n\n${prompt.slice(-6000)}`;
  const args = ['-p', '--no-session', '-nt', '-ne', '-ns', '-nc', '-np', '--provider', 'openai-codex', '--model', 'gpt-5.6-luna', ask];
  return new Promise(resolve => {
    // pi waits for piped input while stdin is open.
    execFile('pi', args, { env: { ...process.env, PI_CODING_AGENT_DIR: PI_DIR }, timeout: 60_000 }, (err, stdout) => {
      syncCredentials();
      const title = stdout.trim().split('\n').pop()?.replace(/^["'“]|["'”.]$/g, '').trim();
      resolve(err || !title ? null : title.slice(0, 60));
    }).stdin?.end();
  });
}
