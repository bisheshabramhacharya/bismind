/**
 * The four harnesses (plus a plain shell) and how to launch each one as a main agent
 * or as a sub-agent. A launch is a small shell script, so each is easy to debug:
 * `cat ~/.bismind/agents/<id>/launch.sh`.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { BASE_URL, BIN, DIR, PI_EXTENSION, type HarnessId, readSettings } from './config.ts';
import { orchestratorPrompt, subagentPrompt, subagentTaskMessage } from './prompts.ts';

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  bin: string | null;
  /** Reports turn completion through a hook/extension (vs. idle detection). */
  reportsTurns: boolean;
  canOrchestrate: boolean;
}

const LABELS: Record<HarnessId, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', devin: 'Devin', shell: 'Terminal' };

const SEARCH_PATH = [
  process.env.PATH ?? '',
  join(process.env.HOME ?? '', '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
].join(delimiter);

function which(bin: string): string | null {
  for (const dir of SEARCH_PATH.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

let cache: HarnessInfo[] | null = null;
export function harnesses(refresh = false): HarnessInfo[] {
  if (cache && !refresh) return cache;
  const shellBin = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  cache = [
    { id: 'claude', label: LABELS.claude, bin: which('claude'), reportsTurns: true, canOrchestrate: true },
    { id: 'codex', label: LABELS.codex, bin: which('codex'), reportsTurns: true, canOrchestrate: true },
    { id: 'pi', label: LABELS.pi, bin: which('pi'), reportsTurns: true, canOrchestrate: true },
    { id: 'devin', label: LABELS.devin, bin: which('devin'), reportsTurns: false, canOrchestrate: false },
    { id: 'shell', label: LABELS.shell, bin: shellBin, reportsTurns: false, canOrchestrate: false },
  ];
  return cache;
}

export function harness(id: string): HarnessInfo {
  const h = harnesses().find(x => x.id === id);
  if (!h) throw new Error(`unknown harness "${id}" — use claude, codex, pi, devin or shell`);
  if (!h.bin) throw new Error(`${h.label} is not installed on this machine`);
  return h;
}

export function harnessLabel(id: string): string {
  return LABELS[id as HarnessId] ?? id;
}

/** Single-quote for /bin/sh. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A `bismind` shim on PATH, so agents can run `bismind ask "…"` from their shell. */
let shimDir: string | null = null;
export function writeShim(): string {
  if (shimDir) return shimDir;
  const binDir = join(DIR, 'bin');
  const shim = join(binDir, 'bismind');
  execFileSync('mkdir', ['-p', binDir]);
  writeFileSync(shim, `#!/bin/sh\nexec ${q(process.execPath)} ${q(BIN)} "$@"\n`);
  chmodSync(shim, 0o755);
  shimDir = binDir;
  return binDir;
}

export interface LaunchInput {
  id: string;
  name: string;
  harness: HarnessId;
  role: 'main' | 'sub';
  cwd: string;
  model: string | null;
  thinking: string | null;
  task: string | null;
  parentLabel: string | null;
  worktree: { branch: string } | null;
  issue: number | null;
  agentDir: string;
  /** Inject orchestration guidance + block native sub-agents (false when mode is native). */
  orchestrate: boolean;
}

function hookCmd(kind: string): string {
  return `${q(process.execPath)} ${q(BIN)} hook ${kind}`;
}

function nodeJsonArray(items: string[]): string {
  return `[${items.map(s => JSON.stringify(s)).join(',')}]`;
}

/** Build the launch script for an agent and return its path. */
export function writeLaunch(input: LaunchInput): string {
  const h = harness(input.harness);
  const settings = readSettings();
  const full = input.role === 'sub' && settings.autonomy === 'full';
  const guidance =
    input.role === 'sub'
      ? subagentPrompt({
          name: input.name,
          parentLabel: input.parentLabel ?? 'the orchestrator',
          cwd: input.cwd,
          worktree: input.worktree,
          askHow: input.harness === 'devin' ? 'run `bismind ask "<one self-contained question>"` in the shell' : 'call the `ask_parent` tool with one self-contained question',
          // Devin has no turn hook, so it hands its report over explicitly.
          reportVia: input.harness === 'devin' ? 'shell' : 'final-message',
          issue: input.issue,
        })
      : input.orchestrate
        ? orchestratorPrompt({ toolStyle: input.harness === 'pi' ? 'pi' : 'mcp' })
        : null;
  const promptFile = join(input.agentDir, 'prompt.md');
  const argv: string[] = [h.bin!];
  let prompt: string | null = input.task;

  switch (input.harness) {
    case 'claude': {
      const claudeSettings = {
        skipDangerousModePermissionPrompt: true,
        permissions: { allow: ['mcp__bismind'] },
        hooks: {
          PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: hookCmd('claude-pretool') }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('claude-prompt') }] }],
          Stop: [{ hooks: [{ type: 'command', command: hookCmd('claude-stop') }] }],
        },
      };
      const settingsPath = join(input.agentDir, 'claude-settings.json');
      writeFileSync(settingsPath, JSON.stringify(claudeSettings, null, 2));
      const mcpPath = join(input.agentDir, 'mcp.json');
      writeFileSync(
        mcpPath,
        JSON.stringify({ mcpServers: { bismind: { type: 'stdio', command: process.execPath, args: [BIN, 'mcp'], env: { BISMIND_AGENT_ID: input.id, BISMIND_ROLE: input.role } } } }, null, 2),
      );
      argv.push('--settings', settingsPath, '--mcp-config', mcpPath);
      if (guidance) argv.push('--append-system-prompt', guidance);
      if (input.model) argv.push('--model', input.model);
      if (input.thinking) argv.push('--effort', input.thinking);
      if (full) argv.push('--dangerously-skip-permissions');
      break;
    }
    case 'codex': {
      argv.push(
        '-c', `mcp_servers.bismind.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.bismind.args=${nodeJsonArray([BIN, 'mcp'])}`,
        '-c', `mcp_servers.bismind.env={BISMIND_AGENT_ID=${JSON.stringify(input.id)},BISMIND_ROLE=${JSON.stringify(input.role)}}`,
        '-c', 'mcp_servers.bismind.tool_timeout_sec=3600',
        '-c', `notify=${nodeJsonArray([process.execPath, BIN, 'hook', 'codex-notify'])}`,
        // An "update available" menu at startup would block a sub-agent that nobody is watching.
        '-c', 'check_for_update_on_startup=false',
      );
      if (guidance) argv.push('-c', `developer_instructions=${JSON.stringify(guidance)}`);
      if (input.model) argv.push('-m', input.model);
      if (input.thinking) argv.push('-c', `model_reasoning_effort=${JSON.stringify(input.thinking)}`);
      if (full) argv.push('--dangerously-bypass-approvals-and-sandbox');
      break;
    }
    case 'pi': {
      argv.push('-e', PI_EXTENSION);
      if (input.model) {
        const slash = input.model.indexOf('/');
        if (slash > 0) argv.push('--provider', input.model.slice(0, slash), '--model', input.model.slice(slash + 1));
        else argv.push('--model', input.model);
      }
      if (input.thinking) argv.push('--thinking', input.thinking);
      if (guidance) argv.push('--append-system-prompt', guidance);
      break;
    }
    case 'devin': {
      // Devin has no system-prompt flag, so a sub-agent's guidance travels with its task.
      if (input.role === 'sub' && prompt) prompt = subagentTaskMessage(prompt, false, guidance ?? '');
      // The user picked this folder (a workspace or a parent's cwd); don't stop on Devin's trust prompt.
      argv.push('--respect-workspace-trust', 'false');
      if (input.model) argv.push('--model', input.model);
      if (full) argv.push('--permission-mode', 'dangerous');
      if (prompt) {
        writeFileSync(promptFile, prompt);
        argv.push('--prompt-file', promptFile);
        prompt = null;
      }
      break;
    }
    case 'shell':
      argv.push('-l');
      prompt = null;
      break;
  }

  if (prompt) writeFileSync(promptFile, prompt);
  const binDir = writeShim();
  const script = [
    '#!/bin/sh',
    `# BisMind launch for ${input.name} (${input.harness}, ${input.role})`,
    `export PATH=${q(`${binDir}${delimiter}${SEARCH_PATH}`)}`,
    `export BISMIND_AGENT_ID=${q(input.id)}`,
    `export BISMIND_AGENT_NAME=${q(input.name)}`,
    `export BISMIND_ROLE=${q(input.role)}`,
    `export BISMIND_URL=${q(BASE_URL)}`,
    'export TERM=xterm-256color COLORTERM=truecolor',
    `cd ${q(input.cwd)} || exit 1`,
    // Positional prompts go last; reading from a file keeps quoting and length sane.
    `exec ${argv.map(q).join(' ')}${prompt ? ` "$(cat ${q(promptFile)})"` : ''}`,
    '',
  ].join('\n');
  const path = join(input.agentDir, 'launch.sh');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}
