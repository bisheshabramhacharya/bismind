#!/usr/bin/env node
/**
 * bismind — talk to any harness, with sub-agents on any harness.
 *
 *   bismind                      open the app window (starts the server if needed)
 *   bismind mode [spec]          show / set the sub-agent mode, e.g. pi:openai-codex/gpt-5.5
 *   bismind new <harness>        start a main agent here and attach to it in this terminal
 *   bismind ls                   agents and their sub-agents
 *   bismind attach <name>        attach this terminal to an agent (detach: ctrl-b d)
 *   …see `bismind help`
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.removeAllListeners('warning');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = await import(join(REPO, 'server', 'config.ts'));

const [command = 'open', ...rest] = process.argv.slice(2);
const flags = {};
const positionals = [];
// Messages are free text: `bismind send w use --force` must send all of it.
const TEXT_COMMANDS = ['send', 'ask', 'done'];
if (TEXT_COMMANDS.includes(command)) positionals.push(...rest);
else for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true);
  } else positionals.push(a);
}

const c = {
  dim: s => `\x1b[2m${s}\x1b[22m`,
  bold: s => `\x1b[1m${s}\x1b[22m`,
  green: s => `\x1b[32m${s}\x1b[39m`,
  yellow: s => `\x1b[33m${s}\x1b[39m`,
  red: s => `\x1b[31m${s}\x1b[39m`,
  blue: s => `\x1b[34m${s}\x1b[39m`,
};

/** Report a usage error with a failing exit code, so scripts can tell. */
function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function client() {
  return import(join(REPO, 'server', 'client.ts'));
}

/** Hooks must be fast and must never break the harness: short timeout, swallow errors. */
async function postEvent(id, body) {
  if (!id) return;
  try {
    const token = cfg.readToken();
    await fetch(`${cfg.BASE_URL}/api/agents/${id}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bismind-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* server down — nothing to report to */
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function lastAssistantFromTranscript(path) {
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').reverse();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      const text = Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : String(content ?? '');
      if (text.trim()) return text;
    }
  } catch {
    /* unreadable transcript */
  }
  return null;
}

async function hook(kind) {
  const id = process.env.BISMIND_AGENT_ID;
  switch (kind) {
    case 'claude-pretool': {
      // Always-redirect: inside BisMind, Claude's own sub-agents are replaced by the chosen mode.
      await readStdin();
      const settings = cfg.readSettings();
      if (!id || settings.mode.harness === 'native') return;
      const reason = process.env.BISMIND_ROLE === 'sub'
        ? "You are a BisMind sub-agent, and sub-agents can't spawn sub-agents. Do this work yourself, or say what's needed in your report."
        : `Sub-agents in BisMind run on the user's sub-agent mode (${cfg.describeMode(settings.mode)}), not the built-in Agent/Task tool. ` +
        'Use mcp__bismind__spawn_subagents with the same brief (one call for all parallel tasks), then mcp__bismind__wait_subagents.';
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
      return;
    }
    case 'claude-prompt': {
      const raw = await readStdin();
      await postEvent(id, { type: 'turn_start' });
      // When the user mentions sub-agents, remind Claude how they work here (and the exact count rule).
      let prompt = '';
      try {
        prompt = JSON.parse(raw || '{}').prompt ?? '';
      } catch {
        /* ignore */
      }
      const settings = cfg.readSettings();
      if (id && process.env.BISMIND_ROLE !== 'sub' && settings.mode.harness !== 'native' && /sub[- ]?agents?|subagents?|parallel agents|agents in parallel/i.test(prompt)) {
        const { subagentReminder } = await import(join(REPO, 'server', 'prompts.ts'));
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: subagentReminder(cfg.describeMode(settings.mode)) } }));
      }
      return;
    }
    case 'claude-stop': {
      const raw = await readStdin();
      let input = {};
      try {
        input = JSON.parse(raw || '{}');
      } catch {
        /* ignore */
      }
      const message = input.last_assistant_message ?? (input.transcript_path ? lastAssistantFromTranscript(input.transcript_path) : null);
      return postEvent(id, { type: 'turn_end', message });
    }
    case 'codex-notify': {
      let payload = {};
      try {
        payload = JSON.parse(positionals[positionals.length - 1] ?? '{}');
      } catch {
        /* ignore */
      }
      if (payload.type && payload.type !== 'agent-turn-complete') return;
      return postEvent(id, { type: 'turn_end', message: payload['last-assistant-message'] ?? null });
    }
    default:
      console.error(`unknown hook ${kind}`);
  }
}

function appUrl(token) {
  const dev = flags.dev ? `http://localhost:${process.env.BISMIND_WEB_PORT ?? 5317}` : cfg.BASE_URL;
  return `${dev}/?t=${token}`;
}

function openWindow(url) {
  const chromes = ['/Applications/Google Chrome.app', '/Applications/Arc.app', '/Applications/Brave Browser.app', '/Applications/Microsoft Edge.app'];
  const app = chromes.find(p => existsSync(p));
  if (process.platform === 'darwin' && app && !flags.browser) {
    spawnSync('open', ['-na', app, '--args', `--app=${url}`], { stdio: 'ignore' });
  } else {
    spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  }
}

function statusColor(s) {
  if (s === 'working' || s === 'starting') return c.blue(s);
  if (s === 'done') return c.green(s);
  if (s === 'waiting') return c.yellow('asking');
  if (s === 'error') return c.red(s);
  return c.dim(s);
}

function tmuxArgs() {
  return ['-L', process.env.BISMIND_TMUX_SOCKET ?? 'bismind', '-f', cfg.TMUX_CONF];
}

function tmuxBin() {
  return ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(p => existsSync(p)) ?? 'tmux';
}

const ORCHESTRATION = ['spawn', 'wait', 'send', 'kill'];

async function main() {
  if (process.env.BISMIND_ROLE === 'sub' && ORCHESTRATION.includes(command)) {
    return fail(`bismind ${command} isn't available to sub-agents. Do the work yourself, or say what's needed in your report.`);
  }
  switch (command) {
    case 'open':
    case 'app': {
      const { ensureServer } = await client();
      await ensureServer();
      if (!flags.dev && !existsSync(join(REPO, 'dist', 'index.html'))) {
        console.log('[bismind] building the UI once…');
        spawnSync('pnpm', ['build'], { cwd: REPO, stdio: 'inherit' });
      }
      const url = appUrl(cfg.readToken());
      openWindow(url);
      console.log(`${c.bold('BisMind')} ${c.dim(url)}`);
      return;
    }
    case 'server':
    case 'serve':
      await import(join(REPO, 'server', 'index.ts'));
      return;
    case 'up': {
      const { ensureServer } = await client();
      await ensureServer();
      console.log(`BisMind server running · ${appUrl(cfg.readToken())}`);
      return;
    }
    case 'stop': {
      const { health } = await client();
      const h = await health();
      if (!h) return console.log('BisMind server is not running.');
      process.kill(h.pid, 'SIGTERM');
      console.log(`stopped server (pid ${h.pid}). Agents keep running in tmux; they reattach on next start.`);
      return;
    }
    case 'mcp': {
      const { startMcp } = await import(join(REPO, 'server', 'mcp.ts'));
      startMcp();
      return;
    }
    case 'hook':
      return hook(positionals[0]);
    case 'mode': {
      const { api } = await client();
      if (positionals[0]) {
        const out = await api('/api/settings', { method: 'PATCH', body: { modeSpec: positionals[0] } });
        console.log(`sub-agent mode → ${c.bold(out.mode.description)}`);
      } else {
        const m = await api('/api/mode');
        console.log(`sub-agent mode: ${c.bold(m.description)}  ${c.dim(`(autonomy: ${m.autonomy})`)}`);
        console.log(c.dim('set with: bismind mode pi:commandcode/deepseek/deepseek-v4.1-flash | pi:openai-codex/gpt-5.5:high | codex:gpt-5.6-sol:high | claude:sonnet | devin:claude-sonnet-5-medium | native'));
      }
      return;
    }
    case 'models': {
      const { api } = await client();
      const h = positionals[0] ?? 'pi';
      const { models } = await api(`/api/models?harness=${h}`);
      for (const m of models) console.log(`${h}:${m.id}`);
      return;
    }
    case 'ls':
    case 'list': {
      const { api } = await client();
      const { agents } = await api('/api/state');
      if (!agents.length) return console.log(c.dim('no agents. start one: bismind new claude'));
      const print = (a, depth) => {
        console.log(`${'  '.repeat(depth)}${depth ? '↳ ' : ''}${c.bold(a.name)} ${c.dim(a.id)}  ${a.harness}${a.model ? c.dim(` · ${a.model}`) : ''}  ${statusColor(a.status)}  ${c.dim(a.cwd)}`);
        for (const child of agents.filter(x => x.parentId === a.id)) print(child, depth + 1);
      };
      for (const a of agents.filter(x => !x.parentId || !agents.some(p => p.id === x.parentId))) print(a, 0);
      return;
    }
    case 'new': {
      const { api } = await client();
      const harness = positionals[0] ?? 'claude';
      const agent = await api('/api/agents', {
        body: { harness, cwd: resolve(flags.cwd ?? process.cwd()), model: flags.model ?? null, cols: process.stdout.columns, rows: process.stdout.rows },
      });
      console.log(`${c.bold(agent.name)} started (${agent.id}). ${c.dim('It shows up in the app too. Detach with ctrl-b d.')}`);
      if (!flags.detached) spawnSync(tmuxBin(), [...tmuxArgs(), 'attach-session', '-t', agent.session], { stdio: 'inherit' });
      return;
    }
    case 'attach': {
      const { api } = await client();
      const target = positionals[0];
      if (!target) return fail('usage: bismind attach <name|id>');
      const a = await api(`/api/agents/${encodeURIComponent(target)}`);
      const { agents } = await api('/api/state');
      const full = agents.find(x => x.id === a.id);
      spawnSync(tmuxBin(), [...tmuxArgs(), 'attach-session', '-t', full.session], { stdio: 'inherit' });
      return;
    }
    case 'ask': {
      const id = process.env.BISMIND_AGENT_ID;
      const question = positionals.join(' ').trim();
      if (!id) return fail('bismind ask only works inside a BisMind sub-agent.');
      if (!question) return fail('usage: bismind ask "your question"');
      const { api } = await client();
      await api(`/api/agents/${id}/ask`, { body: { question } });
      console.log('Question sent to your parent agent. End your turn now; the answer will arrive as your next message.');
      return;
    }
    case 'done': {
      const id = process.env.BISMIND_AGENT_ID;
      if (!id) return fail('bismind done only works inside a BisMind sub-agent.');
      // The report comes as arguments or on stdin (a heredoc keeps multi-line reports intact).
      const report = (positionals.join(' ') || (await readStdin())).trim();
      if (!report) return fail("usage: bismind done \"report\"   or   bismind done <<'EOF' … EOF");
      const { api } = await client();
      await api(`/api/agents/${id}/done`, { body: { report } });
      console.log('Report handed to your parent. You are done; end your turn.');
      return;
    }
    case 'spawn': {
      const { api } = await client();
      const task = flags.task ?? positionals.join(' ');
      if (!task) return fail('usage: bismind spawn --task "brief" [--harness pi] [--model …] [--name …] [--isolate]');
      const out = await api('/api/subagents', {
        body: {
          parentId: process.env.BISMIND_AGENT_ID ?? null,
          cwd: process.cwd(),
          tasks: [{ task, harness: flags.harness, model: flags.model, thinking: flags.thinking, name: flags.name, isolate: Boolean(flags.isolate) }],
        },
        timeoutMs: 120_000,
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'wait': {
      const { api } = await client();
      const timeoutMs = Number(flags.timeout ?? 900) * 1000;
      const out = await api('/api/wait', {
        body: { parentId: process.env.BISMIND_AGENT_ID ?? null, ids: positionals.length ? positionals : undefined, until: flags.any ? 'any' : 'all', timeoutMs },
        timeoutMs: timeoutMs + 30_000,
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'send': {
      const [target, ...words] = positionals;
      if (!target || !words.length) return fail('usage: bismind send <name|id> "message"');
      const { api } = await client();
      await api(`/api/agents/${encodeURIComponent(target)}/message`, { body: { text: words.join(' ') } });
      return;
    }
    case 'read': {
      const { api } = await client();
      if (!positionals[0]) return fail('usage: bismind read <name|id> [--lines 120]');
      const a = await api(`/api/agents/${encodeURIComponent(positionals[0])}/read?lines=${flags.lines ?? 120}`);
      const head = [`${a.name} (${a.id}) · ${a.harness}${a.model ? ` · ${a.model}` : ''} · ${a.role === 'sub' ? 'sub-agent' : 'main agent'} · ${a.status} · ${a.elapsed}`];
      head.push(`cwd: ${a.cwd}${a.branch ? `  branch: ${a.branch}` : ''}${a.parent ? `  parent: ${a.parent}` : ''}`);
      if (a.question) head.push(`\nasking: ${a.question}`);
      if (a.task) head.push(`\n── task ──\n${a.task}`);
      if (a.result) head.push(`\n── last report ──\n${a.result}`);
      console.log(`${head.join('\n')}\n\n── screen ──\n${a.screen}`);
      return;
    }
    case 'kill': {
      if (!positionals[0]) return fail('usage: bismind kill <name|id>');
      const { api } = await client();
      await api(`/api/agents/${encodeURIComponent(positionals[0])}`, { method: 'DELETE' });
      return;
    }
    case 'install': {
      const target = positionals[0];
      const mcp = [process.execPath, join(REPO, 'bin', 'bismind.mjs'), 'mcp'];
      const cmds = {
        claude: ['claude', ['mcp', 'add', '-s', 'user', 'bismind', '--', ...mcp]],
        codex: ['codex', ['mcp', 'add', 'bismind', '--', ...mcp]],
      };
      if (!cmds[target]) {
        console.log('usage: bismind install claude|codex');
        console.log(c.dim('Registers the BisMind MCP bridge globally, so sessions started OUTSIDE the app can spawn sub-agents too.'));
        console.log(c.dim('Agents started inside BisMind already get it automatically.'));
        return;
      }
      const [bin, args] = cmds[target];
      if (target === 'claude') spawnSync('claude', ['mcp', 'remove', '-s', 'user', 'bismind'], { stdio: 'ignore' });
      if (target === 'codex') spawnSync('codex', ['mcp', 'remove', 'bismind'], { stdio: 'ignore' });
      const r = spawnSync(bin, args, { stdio: 'inherit' });
      process.exitCode = r.status ?? 1;
      return;
    }
    case 'doctor': {
      const { health } = await client();
      const h = await health();
      console.log(`server   ${h ? c.green(`running (pid ${h.pid})`) : c.yellow('not running (starts on demand)')}`);
      console.log(`tmux     ${existsSync(tmuxBin()) ? c.green(tmuxBin()) : c.red('missing — brew install tmux')}`);
      const { harnesses } = await import(join(REPO, 'server', 'harnesses.ts'));
      for (const x of harnesses(true)) console.log(`${x.id.padEnd(8)} ${x.bin ? c.green(x.bin) : c.dim('not installed')}`);
      console.log(`mode     ${cfg.describeMode(cfg.readSettings().mode)}`);
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(`${c.bold('bismind')} — talk to any harness; sub-agents on any harness

  ${c.bold('bismind')}                       open the app window
  ${c.bold('bismind new')} <harness>          start claude|codex|pi|devin|shell here, attached to this terminal
  ${c.bold('bismind ls')}                     agents and their sub-agents
  ${c.bold('bismind attach')} <name>          attach this terminal to any agent (detach: ctrl-b d)
  ${c.bold('bismind mode')} [spec]            show/set sub-agent mode: pi:<provider/model>[:thinking] | codex:<model> | claude:<model> | devin:<model> | native
  ${c.bold('bismind models')} <harness>       list models you can use in a mode spec

  ${c.dim('orchestration from any shell (what the MCP tools do):')}
  bismind spawn --task "…" [--harness pi] [--model …] [--isolate]
  bismind wait [names…] [--any] [--timeout 900]
  bismind send <name> "message"     bismind read <name>     bismind kill <name>
  bismind ask "question"            ${c.dim('(inside a sub-agent: ask your parent)')}
  bismind done "report"             ${c.dim('(inside a sub-agent: hand in your report; also reads stdin)')}

  bismind up | stop | doctor | install claude|codex | mcp | server`);
      return;
    default:
      console.error(`unknown command "${command}" — see bismind help`);
      process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`[bismind] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
