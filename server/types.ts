export type PaneMode = 'interactive' | 'exec' | 'shell';

export type PaneStatus = 'starting' | 'working' | 'idle' | 'exited' | 'error';

export interface PaneInfo {
  id: string;
  title: string;
  cli: string;
  cliLabel: string;
  accent: string;
  cwd: string;
  command: string;
  mode: PaneMode;
  status: PaneStatus;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
  parentId: string | null;
  prompt: string | null;
  model: string | null;
  provider: string | null;
  /** True when the pane runs the CLI's interactive TUI (visible sub-agent). */
  headed: boolean;
}

export interface CliAvailability {
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
  createdAt: number;
}

export interface BisMindState {
  workspaces: Workspace[];
  layout: 'stack' | 'split';
  sidebarHidden: boolean;
  paneWorkspace: Record<string, string>;
}
