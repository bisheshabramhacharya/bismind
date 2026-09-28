/** Harness names and status groups, shared by every part of the UI. */
import type { Agent, AgentStatus, HarnessId } from './types';

export const HARNESS_LABEL: Record<HarnessId, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', devin: 'Devin', droid: 'Droid', shell: 'Terminal' };

/** Harnesses that can run sub-agents, in picker order, with the short labels the pickers fit. */
export const AGENT_HARNESSES: { id: Exclude<HarnessId, 'shell'>; short: string }[] = [
  { id: 'pi', short: 'Pi' },
  { id: 'codex', short: 'Codex' },
  { id: 'claude', short: 'Claude' },
  { id: 'devin', short: 'Devin' },
  { id: 'droid', short: 'Droid' },
];

/** Every harness you can open as a main agent, in picker order. */
export const MAIN_HARNESSES: HarnessId[] = ['claude', 'codex', 'pi', 'devin', 'droid', 'shell'];

export function harnessLabel(id: string): string {
  return HARNESS_LABEL[id as HarnessId] ?? id;
}

const RUNNING: AgentStatus[] = ['starting', 'working'];
const ENDED: AgentStatus[] = ['exited', 'error'];

/** Starting or working: its timer ticks and it counts as busy. */
export const isRunning = (a: Pick<Agent, 'status'>) => RUNNING.includes(a.status);
/** Its process is gone. */
export const isEnded = (a: Pick<Agent, 'status'>) => ENDED.includes(a.status);
