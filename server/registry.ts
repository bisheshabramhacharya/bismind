import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import type { CliAvailability } from './types.ts';

function isGitRepo(dir: string): boolean {
  let current = dir;
  for (let i = 0; i < 24; i += 1) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = join(current, '..');
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

export interface SpawnSpec {
  file: string;
  args: string[];
}

export interface ModelChoice {
  model?: string | null;
  provider?: string | null;
}

export interface CliSpec {
  id: string;
  label: string;
  /** Candidate binaries; first one found on PATH wins. */
  bins: string[];
  accent: string;
  /** Interactive TUI invocation. */
  interactive: (bin: string) => SpawnSpec;
  /**
   * Headless flags. The prompt is appended by BisMind as the final argument, so
   * flags that take the prompt as their value (grok `-p <PROMPT>`) stay correct.
   * When absent, BisMind drives the interactive TUI instead.
   */
  exec?: (bin: string, ctx: { cwd: string }) => SpawnSpec;
  /** Flags that select a model/provider for this CLI. */
  modelArgs?: (choice: ModelChoice) => string[];
  /** Install hint shown in the UI when the CLI is missing. */
  hint: string;
  /** Providers this CLI can be pointed at (used by the model picker). */
  providers?: string[];
  /** argv used to register the BisMind MCP bridge with this CLI, if it supports MCP. */
  mcpAdd?: string[];
  custom?: boolean;
}

const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';

export const CLI_SPECS: CliSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bins: ['claude'],
    accent: '#d77757',
    interactive: bin => ({ file: bin, args: [] }),
    exec: bin => ({ file: bin, args: ['-p'] }),
    modelArgs: ({ model }) => (model ? ['--model', model] : []),
    hint: 'npm i -g @anthropic-ai/claude-code',
    mcpAdd: ['mcp', 'add', 'bismind', '--', 'BISMIND_MCP'],
  },
  {
    id: 'codex',
    label: 'Codex',
    bins: ['codex'],
    accent: '#e5e5e5',
    interactive: bin => ({ file: bin, args: [] }),
    exec: (bin, ctx) => ({ file: bin, args: ['exec', ...(isGitRepo(ctx.cwd) ? [] : ['--skip-git-repo-check'])] }),
    modelArgs: ({ model }) => (model ? ['--model', model] : []),
    hint: 'npm i -g @openai/codex',
    mcpAdd: ['mcp', 'add', 'bismind', '--', 'BISMIND_MCP'],
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    bins: ['cursor-agent', 'cursor'],
    accent: '#7c6bff',
    interactive: bin => ({ file: bin, args: [] }),
    exec: bin => ({ file: bin, args: ['-p', '--output-format', 'text'] }),
    modelArgs: ({ model }) => (model ? ['--model', model] : []),
    hint: 'curl https://cursor.com/install -fsS | bash',
    mcpAdd: ['mcp', 'add', 'bismind', 'BISMIND_MCP'],
  },
  {
    id: 'devin',
    label: 'Devin',
    bins: ['devin'],
    accent: '#5cc8ff',
    interactive: bin => ({ file: bin, args: [] }),
    exec: bin => ({ file: bin, args: ['-p'] }),
    modelArgs: ({ model }) => (model ? ['--model', model] : []),
    hint: 'brew install devin',
    mcpAdd: ['mcp', 'add', 'bismind', 'BISMIND_MCP'],
  },
  {
    id: 'grok',
    label: 'Grok Build',
    bins: ['grok'],
    accent: '#f2f2f2',
    interactive: bin => ({ file: bin, args: [] }),
    exec: bin => ({ file: bin, args: ['-p'] }),
    modelArgs: ({ model }) => (model ? ['--model', model] : []),
    hint: 'npm i -g @xai/grok-cli',
    mcpAdd: ['mcp', 'add', 'bismind', 'BISMIND_MCP'],
  },
  {
    id: 'pi',
    label: 'Pi',
    bins: ['pi'],
    accent: '#ffb86b',
    interactive: bin => ({ file: bin, args: [] }),
    exec: bin => ({ file: bin, args: ['-p'] }),
    // Pi takes a provider and a model pattern, e.g. --provider openai --model gpt-5
    modelArgs: ({ model, provider }) => [
      ...(provider ? ['--provider', provider] : []),
      ...(model ? ['--model', model] : []),
    ],
    hint: 'npm i -g @earendil-works/pi-coding-agent',
    providers: ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'openrouter', 'groq', 'cerebras', 'fireworks', 'together', 'mistral', 'moonshot', 'zai'],
    mcpAdd: ['mcp', 'add', 'bismind', 'BISMIND_MCP'],
  },
  {
    id: 'commandcode',
    label: 'Command Code',
    bins: ['command-code', 'commandcode', 'cmdc'],
    accent: '#a0f0a0',
    interactive: bin => ({ file: bin, args: [] }),
    exec: bin => ({ file: bin, args: ['-p'] }),
    modelArgs: ({ model }) => (model ? ['--model', model] : []),
    hint: 'npm i -g command-code',
    mcpAdd: ['mcp', 'add', 'bismind', 'BISMIND_MCP'],
  },
  {
    id: 'opencode',
    label: 'opencode',
    bins: ['opencode'],
    accent: '#8b8b8b',
    interactive: bin => ({ file: bin, args: [] }),
    exec: bin => ({ file: bin, args: ['run'] }),
    modelArgs: ({ model }) => (model ? ['--model', model] : []),
    hint: 'curl -fsSL https://opencode.ai/install | bash',
    mcpAdd: ['mcp', 'add', 'bismind', 'BISMIND_MCP'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bins: ['gemini'],
    accent: '#8ab4ff',
    interactive: bin => ({ file: bin, args: [] }),
    exec: bin => ({ file: bin, args: ['-p'] }),
    modelArgs: ({ model }) => (model ? ['--model', model] : []),
    hint: 'npm i -g @google/gemini-cli',
    mcpAdd: ['mcp', 'add', 'bismind', 'BISMIND_MCP'],
  },
  {
    id: 'cline',
    label: 'Cline',
    bins: ['cline'],
    accent: '#6ee7b7',
    interactive: bin => ({ file: bin, args: [] }),
    hint: 'npm i -g cline',
    mcpAdd: ['mcp', 'add', 'bismind', 'BISMIND_MCP'],
  },
  {
    id: 'shell',
    label: 'Terminal',
    bins: [shell],
    accent: '#4ade80',
    interactive: bin => ({ file: bin, args: ['-l'] }),
    hint: 'always available',
  },
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path) && !statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function findBin(bins: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const bin of bins) {
    if (bin.includes('/')) {
      if (isExecutable(bin)) return bin;
      continue;
    }
    for (const dir of dirs) {
      const candidate = join(dir, bin);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Custom CLIs from ~/.bismind/clis.json, so the registry is not limited to the built-ins. */
export function loadCustomSpecs(): CliSpec[] {
  const path = join(homedir(), '.bismind', 'clis.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(entry => {
      const e = entry as Partial<Omit<CliSpec, 'exec' | 'modelArgs'>> & { exec?: unknown; args?: unknown; modelArgs?: unknown };
      if (!e?.id || !e?.label || !Array.isArray(e.bins)) return [];
      const execArgs = Array.isArray(e.exec) ? (e.exec as string[]) : null;
      return [
        {
          id: String(e.id),
          label: String(e.label),
          bins: e.bins.map(String),
          accent: e.accent ? String(e.accent) : '#9ca3af',
          hint: e.hint ? String(e.hint) : 'custom CLI',
          custom: true,
          interactive: (bin: string) => ({ file: bin, args: Array.isArray(e.args) ? (e.args as string[]) : [] }),
          exec: execArgs ? (bin: string) => ({ file: bin, args: execArgs }) : undefined,
          modelArgs: Array.isArray(e.modelArgs) ? () => (e.modelArgs as string[]) : undefined,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function allSpecs(): CliSpec[] {
  return [...CLI_SPECS, ...loadCustomSpecs()];
}

export function getSpec(id: string): CliSpec | undefined {
  return allSpecs().find(s => s.id === id);
}

export function listClis(): CliAvailability[] {
  return allSpecs().map(spec => {
    const bin = findBin(spec.bins);
    return {
      id: spec.id,
      label: spec.label,
      available: Boolean(bin),
      bin,
      accent: spec.accent,
      hint: spec.hint,
      providers: spec.providers,
      interactiveOnly: !spec.exec,
      custom: Boolean(spec.custom),
      modelArg: Boolean(spec.modelArgs),
    };
  });
}

export interface ResolvedSpawn extends SpawnSpec {
  mode: 'interactive' | 'exec' | 'shell';
  cliLabel: string;
  accent: string;
}

export interface ResolveOptions {
  cliId: string;
  prompt?: string | null;
  args?: string[];
  cwd?: string;
  model?: string | null;
  provider?: string | null;
}

export function resolveSpawn(opts: ResolveOptions): ResolvedSpawn {
  const { cliId, prompt = null, args: extraArgs = [], cwd = process.cwd(), model = null, provider = null } = opts;
  const spec = getSpec(cliId);
  if (!spec) throw new Error(`unknown CLI: ${cliId}`);
  const bin = findBin(spec.bins);
  if (!bin) throw new Error(`${spec.label} is not installed (${spec.hint})`);

  const modelArgs = spec.modelArgs ? spec.modelArgs({ model, provider }) : [];

  if (spec.id === 'shell') {
    const base = spec.interactive(bin);
    return { file: base.file, args: extraArgs.length ? extraArgs : base.args, mode: 'shell', cliLabel: spec.label, accent: spec.accent };
  }

  const wantsPrompt = Boolean(prompt && prompt.trim().length > 0);
  if (wantsPrompt && spec.exec) {
    const base = spec.exec(bin, { cwd });
    // The prompt is appended last so flags that consume it as a value (grok `-p <PROMPT>`) stay correct.
    return { file: base.file, args: [...base.args, ...modelArgs, ...extraArgs, prompt!.trim()], mode: 'exec', cliLabel: spec.label, accent: spec.accent };
  }

  const base = spec.interactive(bin);
  return { file: base.file, args: [...base.args, ...modelArgs, ...extraArgs], mode: 'interactive', cliLabel: spec.label, accent: spec.accent };
}
