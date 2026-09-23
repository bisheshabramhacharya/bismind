import { useState } from 'react';
import { api, setState, useStore } from '../lib/store';
import type { Agent, HarnessId, Workspace } from '../lib/types';
import { HarnessIcon, Icon } from './Icons';
import { Pane } from './Pane';

/** Agents started outside a workspace (e.g. from the CLI) belong to the workspace containing their folder. */
export function workspaceOf(a: Agent, workspaces: Workspace[], agents: Agent[]): string | null {
  if (a.workspaceId && workspaces.some(w => w.id === a.workspaceId)) return a.workspaceId;
  if (a.parentId) {
    const parent = agents.find(p => p.id === a.parentId);
    if (parent) return workspaceOf(parent, workspaces, agents);
  }
  const match = workspaces.filter(w => a.cwd === w.path || a.cwd.startsWith(`${w.path}/`)).sort((x, y) => y.path.length - x.path.length)[0];
  return match?.id ?? null;
}

const PICKS: { id: HarnessId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'pi', label: 'Pi' },
  { id: 'devin', label: 'Devin' },
  { id: 'shell', label: 'Terminal' },
];

export function AgentPicker({ workspace, onDone }: { workspace: Workspace | null; onDone?: () => void }) {
  const harnesses = useStore(s => s.harnesses);
  const home = useStore(s => s.home);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const launch = async (id: HarnessId) => {
    setBusy(id);
    setError(null);
    try {
      const agent = await api<Agent>('/api/agents', { body: { harness: id, workspaceId: workspace?.id ?? null, cwd: workspace?.path ?? home } });
      setState({ focusedId: agent.id, maximizedId: null });
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="picker-grid">
        {PICKS.map(p => {
          const installed = Boolean(harnesses.find(h => h.id === p.id)?.bin);
          return (
            <button key={p.id} className="pick" disabled={!installed || Boolean(busy)} onClick={() => launch(p.id)} title={installed ? '' : `${p.label} is not installed`}>
              <HarnessIcon id={p.id} size={16} />
              <span>{busy === p.id ? 'Starting…' : p.label}</span>
              {!installed && <span className="pick-missing">not installed</span>}
            </button>
          );
        })}
      </div>
      {error && <p className="picker-error">{error}</p>}
    </>
  );
}

export function PickerModal({ workspace, onClose }: { workspace: Workspace | null; onClose: () => void }) {
  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <h3>New agent in {workspace?.name ?? 'home'}</h3>
        <AgentPicker workspace={workspace} onDone={onClose} />
      </div>
    </div>
  );
}

export function Canvas({ onNew }: { onNew: () => void }) {
  const settings = useStore(s => s.settings);
  const agents = useStore(s => s.agents);
  const peeked = useStore(s => s.peeked);
  const hidden = useStore(s => s.hidden);
  const maximizedId = useStore(s => s.maximizedId);
  if (!settings) return null;
  const ws = settings.workspaces.find(w => w.id === settings.activeWorkspace) ?? null;
  const inWs = agents.filter(a => workspaceOf(a, settings.workspaces, agents) === (ws?.id ?? null));
  const show = settings.ui.showSubagents;
  const shown = inWs.filter(a => !hidden.includes(a.id) && (a.role === 'main' || show || peeked.includes(a.id)));

  const maxed = maximizedId ? shown.find(a => a.id === maximizedId) : null;
  if (maxed) {
    return (
      <div className="canvas">
        <Pane key={maxed.id} agent={maxed} onNew={onNew} />
      </div>
    );
  }

  // Teams: each shown agent with its shown sub-agents; a sub-agent whose parent is hidden leads its own team.
  const ids = new Set(shown.map(a => a.id));
  const leaders = shown.filter(a => !a.parentId || !ids.has(a.parentId));
  const subsOf = (id: string): Agent[] => shown.filter(a => a.parentId === id).flatMap(a => [a, ...subsOf(a.id)]);
  const teams = leaders.map(lead => ({ lead, subs: subsOf(lead.id) }));

  if (!teams.length) {
    return (
      <div className="canvas canvas-empty surface">
        <div className="empty">
          <Icon.Layout size={36} />
          <h2>Start vibe coding in {ws?.name ?? 'your home folder'}</h2>
          <p>Choose an agent to open a terminal.</p>
          <AgentPicker workspace={ws} />
          <p className="empty-foot">{inWs.length ? `${inWs.length} pane${inWs.length > 1 ? 's are' : ' is'} hidden and still running. Click one in the sidebar to bring it back (⌘J toggles sub-agents).` : 'These run in real terminals over your own folders. Sub-agents use your mode: pick it in the dashboard.'}</p>
        </div>
      </div>
    );
  }

  if (settings.ui.layout !== 'stack') {
    const flat = teams.flatMap(t => [t.lead, ...t.subs]);
    const cols = settings.ui.layout === 'columns' ? flat.length : Math.ceil(Math.sqrt(flat.length));
    return (
      <div className="canvas canvas-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {flat.map(a => (
          <Pane key={a.id} agent={a} onNew={onNew} />
        ))}
      </div>
    );
  }

  return (
    <div className="canvas">
      {teams.map(({ lead, subs }) => (
        <div key={lead.id} className={`team ${subs.length ? 'team-split' : ''}`}>
          <div className="team-lead">
            <Pane agent={lead} onNew={onNew} />
          </div>
          {subs.length > 0 && (
            <div className={`team-subs ${subs.length > 3 ? 'team-subs-grid' : ''}`}>
              {subs.map(a => (
                <Pane key={a.id} agent={a} onNew={onNew} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
