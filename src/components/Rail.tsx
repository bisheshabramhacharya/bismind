import { useEffect, useRef, useState } from 'react';
import { api, patchSettings, patchUi, setState, useStore } from '../lib/store';
import type { Agent } from '../lib/types';
import { workspaceOf } from './Canvas';
import { HarnessIcon, Icon } from './Icons';
import { StatusDot, openSubagent } from './Pane';

function AddWorkspace({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('~/');
  const [hints, setHints] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(() => {
      api<string[]>(`/api/dirs?prefix=${encodeURIComponent(value)}`)
        .then(list => {
          setHints(list);
          setSel(0);
        })
        .catch(() => setHints([]));
    }, 80);
    return () => clearTimeout(t);
  }, [value]);

  const add = async (path: string) => {
    try {
      await api('/api/workspaces', { body: { path } });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="addws">
      <input
        ref={input}
        value={value}
        spellCheck={false}
        placeholder="~/Projects/my-app"
        onChange={e => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={e => {
          if (e.key === 'Escape') onDone();
          if (e.key === 'ArrowDown') (e.preventDefault(), setSel(s => Math.min(s + 1, hints.length - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setSel(s => Math.max(s - 1, 0)));
          if (e.key === 'Tab' && hints[sel]) (e.preventDefault(), setValue(`${hints[sel]}/`));
          if (e.key === 'Enter') void add(value.replace(/\/$/, '') || '~');
        }}
      />
      <div className="addws-help">Tab completes · Enter adds · Esc cancels</div>
      {hints.length > 0 && (
        <div className="addws-hints">
          {hints.map((h, i) => (
            <button key={h} className={i === sel ? 'on' : ''} onMouseDown={e => (e.preventDefault(), setValue(`${h}/`))}>
              <Icon.Folder size={13} /> {h.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      {error && <div className="addws-error">{error}</div>}
    </div>
  );
}

const LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', devin: 'Devin', shell: 'Terminal' };
function labelFor(a: Agent): string {
  if (a.role === 'sub') return a.name;
  const m = a.name.match(/^(claude|codex|pi|devin|terminal)(?:-(\d+))?$/);
  if (!m) return a.name;
  return `${LABELS[m[1] === 'terminal' ? 'shell' : m[1]]}${m[2] ? ` ${m[2]}` : ''}`;
}

function AgentRow({ agent, depth, all }: { agent: Agent; depth: number; all: Agent[] }) {
  const focused = useStore(s => s.focusedId === agent.id);
  const kids = all.filter(a => a.parentId === agent.id);
  return (
    <>
      <button
        className={`rail-agent ${focused ? 'on' : ''}`}
        style={{ paddingLeft: 22 + depth * 14 }}
        onClick={() => (agent.role === 'sub' ? openSubagent(agent.id) : setState({ focusedId: agent.id, maximizedId: null }))}
        title={agent.task ?? agent.cwd}
      >
        <StatusDot status={agent.status} />
        {depth > 0 && <span className="rail-branch">↳</span>}
        <span className="rail-agent-name">{labelFor(agent)}</span>
        {agent.role === 'sub' && <HarnessIcon id={agent.harness} size={12} />}
      </button>
      {kids.map(k => (
        <AgentRow key={k.id} agent={k} depth={depth + 1} all={all} />
      ))}
    </>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const settings = useStore(s => s.settings)!;
  const [name, setName] = useState(settings.userName);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const ui = settings.ui;
  return (
    <div className="popover" ref={box}>
      <h4>Settings</h4>
      <label className="setting">
        <span className="setting-label">Your name</span>
        <input className="field" value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && void patchSettings({ userName: name })} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </label>
      <div className="setting">
        <span className="setting-label">Appearance</span>
        <div className="seg">
          <button className={ui.theme === 'dark' ? 'on' : ''} onClick={() => patchUi({ theme: 'dark' })}>
            <Icon.Moon size={13} /> Dark
          </button>
          <button className={ui.theme === 'light' ? 'on' : ''} onClick={() => patchUi({ theme: 'light' })}>
            <Icon.Sun size={13} /> Light
          </button>
        </div>
      </div>
      <div className="setting">
        <span className="setting-label">Canvas layout</span>
        <div className="seg">
          {(['stack', 'grid', 'columns'] as const).map(l => (
            <button key={l} className={ui.layout === l ? 'on' : ''} onClick={() => patchUi({ layout: l })}>
              {l[0].toUpperCase() + l.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <span className="setting-label">Sub-agent permissions</span>
        <div className="seg">
          <button className={settings.autonomy === 'full' ? 'on' : ''} onClick={() => void patchSettings({ autonomy: 'full' })}>
            Full auto
          </button>
          <button className={settings.autonomy === 'ask' ? 'on' : ''} onClick={() => void patchSettings({ autonomy: 'ask' })}>
            Ask me
          </button>
        </div>
        <span className="setting-help">Full auto runs sub-agents without permission prompts. Ask me keeps each harness's prompts; you answer in the sub-agent's pane.</span>
      </div>
      <div className="setting">
        <span className="setting-label">Shortcuts</span>
        <span className="setting-help">
          <kbd>⌘K</kbd> new agent · <kbd>⌘J</kbd> sub-agent panes · <kbd>⌘B</kbd> workspaces · <kbd>⇧⌘B</kbd> dashboard
        </span>
        <span className="setting-help">
          In any terminal: <code>bismind attach &lt;name&gt;</code>
        </span>
      </div>
    </div>
  );
}

export function Rail() {
  const settings = useStore(s => s.settings);
  const agents = useStore(s => s.agents);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (!settings) return null;

  const groups = [
    ...settings.workspaces.map(w => ({ id: w.id as string | null, name: w.name, path: w.path })),
    ...(agents.some(a => workspaceOf(a, settings.workspaces, agents) === null) || settings.workspaces.length === 0 ? [{ id: null, name: 'Home', path: '~' }] : []),
  ];
  const dark = settings.ui.theme === 'dark';

  return (
    <aside className="rail surface">
      <div className="section-head">
        <span>Workspaces</span>
        <button className="icon-btn" title="Add a folder" onClick={() => setAdding(a => !a)}>
          <Icon.Plus size={15} />
        </button>
      </div>
      {adding && <AddWorkspace onDone={() => setAdding(false)} />}
      <nav className="rail-list">
        {groups.map(g => {
          const inWs = agents.filter(a => workspaceOf(a, settings.workspaces, agents) === g.id);
          const roots = inWs.filter(a => !a.parentId || !inWs.some(p => p.id === a.parentId));
          const active = settings.activeWorkspace === g.id;
          const open = active ? collapsed[String(g.id)] !== true : collapsed[String(g.id)] === false;
          const live = inWs.filter(a => !['exited', 'error'].includes(a.status)).length;
          return (
            <div key={String(g.id)}>
              <div className={`rail-ws ${active ? 'on' : ''}`} onClick={() => void patchSettings({ activeWorkspace: g.id })} title={g.path}>
                <span className="rail-ws-name">{g.name}</span>
                {g.id && (
                  <button
                    className="rail-remove"
                    title="Remove from list (the folder is untouched)"
                    onClick={e => {
                      e.stopPropagation();
                      void api(`/api/workspaces/${g.id}`, { method: 'DELETE' });
                    }}
                  >
                    <Icon.Close size={11} />
                  </button>
                )}
                {inWs.length > 0 && (
                  <button
                    className={`rail-caret ${open ? 'open' : ''}`}
                    onClick={e => {
                      e.stopPropagation();
                      setCollapsed(c => ({ ...c, [String(g.id)]: open }));
                    }}
                  >
                    <Icon.Chevron size={12} />
                  </button>
                )}
                {live > 0 && <span className="count">{live}</span>}
              </div>
              {open && roots.map(a => <AgentRow key={a.id} agent={a} depth={0} all={inWs} />)}
            </div>
          );
        })}
      </nav>
      <footer className="rail-foot">
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
        <button className={`account ${settingsOpen ? 'on' : ''}`} onClick={() => setSettingsOpen(o => !o)} title="Settings">
          <span className="avatar">{settings.userName.slice(0, 1).toUpperCase()}</span>
          <span className="account-lines">
            <span className="account-name">{settings.userName}</span>
            <span className="account-sub">Settings</span>
          </span>
        </button>
        <button className="icon-btn" title={dark ? 'Light mode' : 'Dark mode'} onClick={() => patchUi({ theme: dark ? 'light' : 'dark' })}>
          {dark ? <Icon.Moon size={15} /> : <Icon.Sun size={15} />}
        </button>
      </footer>
    </aside>
  );
}
