export type HarnessId = 'claude' | 'codex' | 'pi' | 'devin' | 'shell';
export type AgentStatus = 'starting' | 'working' | 'idle' | 'done' | 'waiting' | 'exited' | 'error';

export interface Agent {
  id: string;
  name: string;
  harness: HarnessId;
  model: string | null;
  thinking: string | null;
  cwd: string;
  workspaceId: string | null;
  role: 'main' | 'sub';
  parentId: string | null;
  task: string | null;
  status: AgentStatus;
  result: string | null;
  question: string | null;
  progress: string | null;
  exitCode: number | null;
  turns: number;
  createdAt: number;
  updatedAt: number;
  workStartedAt: number | null;
  finishedAt: number | null;
  worktree: { path: string; branch: string; repo: string; base?: string } | null;
  issue?: number | null;
  reviewOf?: string | null;
  session: string;
}

export interface SubagentMode {
  harness: HarnessId | 'native';
  model: string | null;
  thinking: string | null;
}

export interface ReviewAgent {
  harness: Exclude<HarnessId, 'shell'> | 'mode';
  model: string | null;
  thinking: string | null;
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
  autonomy: 'full' | 'ask';
  workspaces: Workspace[];
  activeWorkspace: string | null;
  ui: { theme: 'dark' | 'light'; layout: 'stack' | 'grid' | 'columns'; showSubagents: boolean; rail: boolean; dashboard: boolean };
}

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  bin: string | null;
  reportsTurns: boolean;
  canOrchestrate: boolean;
}

export interface ModeInfo {
  mode: SubagentMode;
  description: string;
  autonomy: 'full' | 'ask';
}

export interface ModelOption {
  id: string;
  label: string;
  group: string;
}
