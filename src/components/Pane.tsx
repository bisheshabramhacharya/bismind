import { useEffect, useState } from 'react';
import { api, elapsed, getState, setState, shortModel, tildify, useStore } from '../lib/store';
import type { Agent } from '../lib/types';
import { HarnessIcon, Icon } from './Icons';
import { Terminal } from './Terminal';

export const STATUS_LABEL: Record<Agent['status'], string> = {
  starting: 'starting',
  working: 'working',
  idle: 'idle',
  done: 'done',
  waiting: 'asking',
  exited: 'exited',
  error: 'error',
};

export function StatusDot({ status }: { status: Agent['status'] }) {
  return <span className={`dot dot-${status}`} />;
}

/** Re-render every second while something is running, so timers tick. */
export function useTick(active: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

export function openSubagent(id: string) {
  const s = getState();
  const showing = s.settings?.ui.showSubagents ?? true;
  setState({ focusedId: id, peeked: showing || s.peeked.includes(id) ? s.peeked : [...s.peeked, id], maximizedId: null });
}

function SubTray({ parent }: { parent: Agent }) {
  const subs = useStore(s => s.agents.filter(a => a.parentId === parent.id));
  const focusedId = useStore(s => s.focusedId);
  useTick(subs.some(a => a.status === 'working' || a.status === 'starting'));
  if (!subs.length) return null;
  const running = subs.filter(a => ['starting', 'working'].includes(a.status)).length;
  return (
    <div className="subtray">
      <span className="subtray-label">
        <Icon.Agents size={13} /> {running ? `${running} running` : `${subs.length} sub-agent${subs.length > 1 ? 's' : ''}`}
      </span>
      <div className="subtray-chips">
        {subs.map(a => (
          <button key={a.id} className={`chip ${focusedId === a.id ? 'chip-on' : ''}`} onClick={() => openSubagent(a.id)} title={a.task ?? ''}>
            <StatusDot status={a.status} />
            <span className="chip-name">{a.name}</span>
            <span className="chip-meta">
              {STATUS_LABEL[a.status]} · {elapsed(a)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Menu({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    onClose();
  };
  return (
    <div className="menu" onMouseLeave={onClose}>
      <button onClick={() => copy(`bismind attach ${agent.name}`)}>
        <Icon.Copy size={14} /> Copy “attach in terminal” command
      </button>
      <button onClick={() => copy(agent.cwd)}>
        <Icon.Folder size={14} /> Copy folder path
      </button>
      {agent.worktree && (
        <button onClick={() => copy(agent.worktree!.branch)}>
          <Icon.Branch size={14} /> Copy branch {agent.worktree.branch}
        </button>
      )}
      {!['exited', 'error'].includes(agent.status) && (
        <button
          onClick={() => {
            void api(`/api/agents/${agent.id}/stop`, { body: {} });
            onClose();
          }}
        >
          <Icon.Stop size={14} /> Stop (keep in list)
        </button>
      )}
    </div>
  );
}

export function Pane({ agent, onNew }: { agent: Agent; onNew: () => void }) {
  const focused = useStore(s => s.focusedId === agent.id);
  const maximized = useStore(s => s.maximizedId === agent.id);
  const parent = useStore(s => (agent.parentId ? s.agents.find(a => a.id === agent.parentId) : null));
  const [menu, setMenu] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  useTick(agent.role === 'sub' && ['working', 'starting'].includes(agent.status));

  useEffect(() => {
    if (!confirmClose) return;
    const t = setTimeout(() => setConfirmClose(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClose]);

  const focus = () => {
    if (!focused) setState({ focusedId: agent.id });
  };
  const close = () => {
    if (!confirmClose && !['exited', 'error'].includes(agent.status)) return setConfirmClose(true);
    void api(`/api/agents/${agent.id}`, { method: 'DELETE' });
  };
  const model = shortModel(agent.model);

  return (
    <section className={`pane ${focused ? 'pane-focused' : ''} ${agent.role === 'sub' ? 'pane-sub' : ''}`} onMouseDown={focus}>
      <header className="pane-head">
        <StatusDot status={agent.status} />
        <HarnessIcon id={agent.harness} size={14} />
        <span className="pane-title">{agent.role === 'sub' ? agent.name : tildify(agent.cwd).split('/').pop() || '~'}</span>
        {agent.role === 'sub' ? (
          <span className="pane-sub-meta">
            ↳ {parent ? `from ${parent.name}` : 'sub-agent'}
            {model ? ` · ${model}` : ''}
            {agent.worktree ? ` · ${agent.worktree.branch}` : ''}
          </span>
        ) : (
          model && <span className="pane-sub-meta">{model}</span>
        )}
        {agent.role === 'sub' && (
          <span className={`state state-${agent.status}`}>
            {STATUS_LABEL[agent.status]} {elapsed(agent)}
          </span>
        )}
        <div className="pane-actions">
          <button className="icon-btn" title="More" onClick={() => setMenu(m => !m)}>
            <Icon.More size={15} />
          </button>
          <button className="icon-btn" title={maximized ? 'Restore' : 'Maximize'} onClick={() => setState({ maximizedId: maximized ? null : agent.id, focusedId: agent.id })}>
            {maximized ? <Icon.Collapse size={13} /> : <Icon.Expand size={13} />}
          </button>
          <button className="icon-btn" title="New agent" onClick={onNew}>
            <Icon.Plus size={15} />
          </button>
          <button className={`icon-btn ${confirmClose ? 'icon-btn-danger' : ''}`} title="Close (stops the agent)" onClick={close}>
            {confirmClose ? <span className="confirm-text">Close?</span> : <Icon.Close size={13} />}
          </button>
        </div>
        {menu && <Menu agent={agent} onClose={() => setMenu(false)} />}
      </header>
      {agent.status === 'waiting' && agent.question && (
        <div className="pane-note pane-note-ask">
          <StatusDot status="waiting" />
          <span>{agent.question}</span>
        </div>
      )}
      <div className="pane-body">
        <Terminal agentId={agent.id} focused={focused} onFocus={focus} />
      </div>
      {agent.role === 'main' && <SubTray parent={agent} />}
    </section>
  );
}
