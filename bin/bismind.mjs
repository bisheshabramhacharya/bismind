#!/usr/bin/env node
/**
 * BisMind CLI: run the pane server, expose the MCP bridge to any agent CLI,
 * and register that bridge with the CLIs installed on this machine.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const HOME = homedir();
const CONFIG_DIR = join(HOME, '.bismind');
const TOKEN_PATH = join(CONFIG_DIR, 'token');
const PID_PATH = join(CONFIG_DIR, 'pid');
const LOG_PATH = join(CONFIG_DIR, 'server.log');
const PORT = Number(process.env.BISMIND_PORT ?? 4317);
const WEB_PORT = Number(process.env.BISMIND_WEB_PORT ?? 5317);

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flags = new Set(args.filter(a => a.startsWith('--')));
const positionals = args.slice(1).filter(a => !a.startsWith('--'));

function readToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  return readFileSync(TOKEN_PATH, 'utf8').trim();
}

async function health() {
  const token = readToken();
  if (!token) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      headers: { 'x-bismind-token': token },
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function tsxBin() {
  const candidate = join(REPO, 'node_modules', '.bin', 'tsx');
  return existsSync(candidate) ? candidate : 'npx';
}

function spawnServer({ detached = true } = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const log = openSync(LOG_PATH, 'a');
  const bin = tsxBin();
  const argv = bin === 'npx' ? ['tsx', join(REPO, 'server', 'index.ts')] : [join(REPO, 'server', 'index.ts')];
  const child = spawn(bin, argv, {
    cwd: REPO,
    detached,
    stdio: ['ignore', log, log],
    env: { ...process.env, BISMIND_PORT: String(PORT) },
  });
  if (detached) child.unref();
  writeFileSync(PID_PATH, String(child.pid ?? ''));
  return child;
}

async function ensureServer({ quiet = false } = {}) {
  const existing = await health();
  if (existing) return existing;
  if (!quiet) console.log('[bismind] starting pane server…');
  spawnServer();
  for (let i = 0; i < 40; i += 1) {
    await new Promise(r => setTimeout(r, 300));
    const ok = await health();
    if (ok) return ok;
  }
  throw new Error(`pane server did not come up — see ${LOG_PATH}`);
}

function mcpCommand() {
  return ['node', join(REPO, 'bin', 'bismind.mjs'), 'mcp'];
}

const CLAUDE_USER_CONFIG = join(HOME, '.claude.json');
const CLAUDE_AGENTS_DIR = join(HOME, '.claude', 'agents');

/** Claude Code user-scope MCP config lives in ~/.claude.json under mcpServers. */
function claudeServerEntry() {
  const [cmd, ...rest] = mcpCommand();
  return { type: 'stdio', command: cmd, args: rest, env: {} };
}

function installClaudeJson(write, { project = false } = {}) {
  const target = project ? join(process.cwd(), '.mcp.json') : CLAUDE_USER_CONFIG;
  let current = {};
  if (existsSync(target)) {
    try {
      current = JSON.parse(readFileSync(target, 'utf8'));
    } catch {
      console.error(`[bismind] ${target} is not valid JSON — leaving it alone`);
      return;
    }
  }
  const next = { ...current, mcpServers: { ...(current.mcpServers ?? {}), bismind: claudeServerEntry() } };
  console.log(`${target}\n${JSON.stringify({ mcpServers: { bismind: next.mcpServers.bismind } }, null, 2)}`);
  if (!write) {
    console.log('\n(re-run with --write to apply)');
    return;
  }
  if (existsSync(target)) copyFileSync(target, `${target}.bismind.bak`);
  writeFileSync(target, JSON.stringify(next, null, 2));
  console.log(`[bismind] registered the bisMind bridge in ${target}`);
}

function subagentDoc({ name, label, cli, description, model }) {
  return `---
name: ${name}
description: ${description}
tools: mcp__bismind__list_clis, mcp__bismind__spawn_agent, mcp__bismind__list_panes, mcp__bismind__read_pane, mcp__bismind__wait_for_agent, mcp__bismind__send_to_pane, mcp__bismind__close_pane
model: inherit
---

You delegate work to the **${label}** CLI (\`${cli}\`) running in a real, visible terminal pane inside BisMind.
${model ? `Unless the user names another model, launch it with \`model: "${model}"\`.\n` : ''}
Workflow:

1. \`mcp__bismind__list_clis\` — confirm \`${cli}\` is installed. If it is missing, say so and stop (do not fake the work).
2. \`mcp__bismind__spawn_agent\` with:
   - \`cli: "${cli}"\`
   - \`cwd\`: the directory the user is working in
   - \`prompt\`: the **complete** task — ${label} starts with no context, so include the file paths, the goal, the constraints and what "done" means
   - \`headed: true\` so the human can watch it work in the canvas${model ? `
   - \`model: "${model}"\`` : ''}
   - \`parent_pane_id\`: your own pane id if you were spawned by BisMind, so the canvas draws the link
3. Follow it with \`mcp__bismind__wait_for_agent\` (\`until: "idle"\` for a TUI, \`until: "exit"\` for a one-shot run) and \`mcp__bismind__read_pane\` to collect results. Prefer waiting over polling in a loop.
4. Report back: the pane id, what ${label} actually did, its output verbatim for anything important, and any failures — never summarise a result you did not read.
5. If ${label} is stuck waiting for input, use \`mcp__bismind__send_to_pane\` to answer it, then keep waiting.
6. Close the pane with \`mcp__bismind__close_pane\` only when the user asks, or the task is finished and the pane is noise.

Keep your own answer short: you are the router, ${label} is the worker.
`;
}

function installClaudeAgents(write) {
  const files = {
    'pi.md': subagentDoc({
      name: 'pi',
      label: 'Pi',
      cli: 'pi',
      description:
        'Delegate a coding task to the Pi CLI in a visible BisMind terminal pane. Use when the user wants pi to do the work, or wants a second model (OpenAI, DeepSeek, Gemini, xAI) to attempt it. Returns pi\'s result.',
      model: '',
    }),
    'devin.md': subagentDoc({
      name: 'devin',
      label: 'Devin',
      cli: 'devin',
      description: 'Delegate a coding task to the Devin CLI in a visible BisMind terminal pane.',
    }),
    'codex.md': subagentDoc({
      name: 'codex',
      label: 'Codex',
      cli: 'codex',
      description: 'Delegate a coding task to the OpenAI Codex CLI in a visible BisMind terminal pane.',
    }),
    'delegate.md': `---
name: delegate
description: Run any CLI agent (pi, codex, devin, cursor-agent, grok, opencode, gemini, copilot, cline or a plain shell) as a visible sub-agent pane through BisMind. Use when the user names a specific CLI, or when a task should run in parallel with yours.
tools: mcp__bismind__list_clis, mcp__bismind__spawn_agent, mcp__bismind__list_panes, mcp__bismind__read_pane, mcp__bismind__wait_for_agent, mcp__bismind__send_to_pane, mcp__bismind__close_pane, mcp__bismind__run_command
model: inherit
---

You are the BisMind dispatcher: you run other CLIs as visible sub-agent panes and bring their results back.

1. \`mcp__bismind__list_clis\` first — only launch CLIs that are actually installed.
2. \`mcp__bismind__spawn_agent\` with \`cli\`, \`cwd\`, a complete self-contained \`prompt\`, \`headed: true\` (default) so the human can watch, plus \`model\`/\`provider\` when the user asked for a specific model.
3. Wait with \`mcp__bismind__wait_for_agent\`, read with \`mcp__bismind__read_pane\`, unblock with \`mcp__bismind__send_to_pane\`.
4. Use \`mcp__bismind__run_command\` for quick shell work that does not need an agent.
5. Never claim a sub-agent result you did not read from its pane.
`,
  };
  mkdirSync(CLAUDE_AGENTS_DIR, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    const target = join(CLAUDE_AGENTS_DIR, file);
    if (write) {
      writeFileSync(target, body);
      console.log(`[bismind] wrote ${target}`);
    } else {
      console.log(`--- ${target} ---\n${body.split('\n').slice(0, 6).join('\n')}\n…`);
    }
  }
  if (!write) console.log('\n(re-run with --write to apply)');
}

const MCP_INSTALLERS = {
  codex: { kind: 'cli', argv: ['mcp', 'add', 'bismind', '--', ...mcpCommand()] },
  grok: { kind: 'cli', argv: ['mcp', 'add', 'bismind', '--', ...mcpCommand()] },
  devin: { kind: 'cli', argv: ['mcp', 'add', 'bismind', '--', ...mcpCommand()] },
  claude: { kind: 'claude', argv: [] },
  cursor: {
    kind: 'json',
    path: join(HOME, '.cursor', 'mcp.json'),
    merge: obj => ({ ...obj, mcpServers: { ...(obj.mcpServers ?? {}), bismind: { command: mcpCommand()[0], args: mcpCommand().slice(1) } } }),
  },
  gemini: {
    kind: 'json',
    path: join(HOME, '.gemini', 'settings.json'),
    merge: obj => ({ ...obj, mcpServers: { ...(obj.mcpServers ?? {}), bismind: { command: mcpCommand()[0], args: mcpCommand().slice(1) } } }),
  },
  opencode: {
    kind: 'json',
    path: join(HOME, '.config', 'opencode', 'opencode.json'),
    merge: obj => ({ ...obj, mcp: { ...(obj.mcp ?? {}), bismind: { type: 'local', command: mcpCommand(), enabled: true } } }),
  },
  copilot: {
    kind: 'json',
    path: join(HOME, '.copilot', 'mcp-config.json'),
    merge: obj => ({ ...obj, mcpServers: { ...(obj.mcpServers ?? {}), bismind: { type: 'local', command: mcpCommand()[0], args: mcpCommand().slice(1), tools: ['*'] } } }),
  },
};

function install(target, write) {
  if (target === 'claude-agents') return installClaudeAgents(write);
  const spec = MCP_INSTALLERS[target];
  if (!spec) {
    console.error(`unknown target "${target}". known: ${Object.keys(MCP_INSTALLERS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (spec.kind === 'claude') return installClaudeJson(write, { project: flags.has('--project') });
  if (spec.kind === 'cli') {
    const pretty = `${target} ${spec.argv.join(' ')}`;
    console.log(pretty);
    if (!write) {
      console.log('\n(re-run with --write to apply)');
      return;
    }
    const child = spawn(target, spec.argv, { stdio: 'inherit' });
    child.on('exit', code => {
      if (code !== 0) console.error(`[bismind] ${target} exited ${code} — if the CLI is missing, add this manually:\n  ${pretty}`);
    });
    return;
  }
  mkdirSync(dirname(spec.path), { recursive: true });
  let current = {};
  if (existsSync(spec.path)) {
    try {
      current = JSON.parse(readFileSync(spec.path, 'utf8'));
    } catch {
      current = {};
    }
  }
  const next = spec.merge(current);
  console.log(`${spec.path}\n${JSON.stringify(next, null, 2)}`);
  if (!write) {
    console.log('\n(re-run with --write to apply)');
    return;
  }
  if (existsSync(spec.path)) copyFileSync(spec.path, `${spec.path}.bismind.bak`);
  writeFileSync(spec.path, JSON.stringify(next, null, 2));
  console.log(`[bismind] wrote ${spec.path}`);
}

async function main() {
  switch (command) {
    case 'up': {
      const info = await ensureServer();
      const token = readToken();
      console.log(`[bismind] pane server up (pid ${info.pid}), ${info.panes} pane(s)`);
      const web = existsSync(join(REPO, 'dist', 'web', 'index.html')) ? `http://127.0.0.1:${PORT}/?t=${token}` : `http://127.0.0.1:${WEB_PORT}/?t=${token}`;
      console.log(`[bismind] open ${web}`);
      if (flags.has('--dev') || !existsSync(join(REPO, 'dist', 'web', 'index.html'))) {
        console.log('[bismind] (dev) start the UI with: pnpm dev:web');
      }
      break;
    }
    case 'mcp': {
      try {
        await ensureServer({ quiet: true });
      } catch (err) {
        console.error(`[bismind] ${err instanceof Error ? err.message : String(err)}`);
      }
      await import('../server/mcp-cli.ts');
      break;
    }
    case 'doctor': {
      await ensureServer({ quiet: true });
      const token = readToken();
      const res = await fetch(`http://127.0.0.1:${PORT}/api/clis`, { headers: { 'x-bismind-token': token } });
      const data = await res.json();
      const notes = {
        pi: 'needs a provider login: run `pi` then /login (or set an API key env var)',
        codex: 'check ~/.codex/config.toml — this machine errors with "gpt-6-luna is not supported on a ChatGPT account"',
        claude: 'not installed yet — install it, then BisMind tools appear automatically',
      };
      console.log('[bismind] agent readiness');
      for (const cli of data.clis) {
        const state = cli.available ? 'ready  ' : 'missing';
        console.log(`  ${state} ${cli.id.padEnd(14)} ${cli.label}${notes[cli.id] ? `\n           ↳ ${notes[cli.id]}` : ''}`);
      }
      console.log('\n  headed sub-agents: POST /api/panes {cli, prompt, headed:true, model?, provider?}');
      break;
    }
    case 'install': {
      const target = positionals[0];
      if (!target) {
        console.error(`usage: bismind install <${[...Object.keys(MCP_INSTALLERS), 'claude-agents'].join('|')}> [--write]`);
        process.exitCode = 1;
        break;
      }
      install(target, flags.has('--write'));
      break;
    }
    case 'clis': {
      await ensureServer({ quiet: true });
      const token = readToken();
      const res = await fetch(`http://127.0.0.1:${PORT}/api/clis`, { headers: { 'x-bismind-token': token } });
      const data = await res.json();
      for (const cli of data.clis) {
        console.log(`${cli.available ? '✓' : '·'} ${cli.id.padEnd(14)} ${cli.label}${cli.available ? `  (${cli.bin})` : `  — ${cli.hint}`}`);
      }
      break;
    }
    case 'status': {
      const info = await health();
      console.log(info ? JSON.stringify(info, null, 2) : `[bismind] not running (log: ${LOG_PATH})`);
      break;
    }
    case 'stop': {
      const pid = existsSync(PID_PATH) ? Number(readFileSync(PID_PATH, 'utf8')) : 0;
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`[bismind] stopped pid ${pid}`);
        } catch {
          console.log('[bismind] no live server process found');
        }
      } else {
        console.log('[bismind] no pid file');
      }
      break;
    }
    default:
      console.log(`bismind — real CLI agent panes, driven by any agent over MCP

  bismind up                start the pane server (and print the canvas URL)
  bismind mcp               run the MCP bridge on stdio (used by agent CLIs)
  bismind install <target>   print the MCP registration for a CLI (--write to apply)
                             targets: ${[...Object.keys(MCP_INSTALLERS), 'claude-agents'].join(', ')}
                               claude-agents → Claude Code subagent files that delegate to pi/devin/codex
  bismind doctor            per-CLI readiness, including auth notes
  bismind clis              list detected agent CLIs
  bismind status            server health
  bismind stop              stop the pane server

  dev:  pnpm dev            vite (5317) + pane server (4317)`);
  }
}

main().catch(err => {
  console.error(`[bismind] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
