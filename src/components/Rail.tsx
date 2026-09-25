import { useEffect, useRef, useState } from 'react';
import { agentRef, api, dragAgent, patchSettings, patchUi, setHidden, setPinned, useStore } from '../lib/store';
import type { Agent } from '../lib/types';
import { showAgent, workspaceOf } from './Canvas';
import { HarnessIcon, Icon } from './Icons';

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
  if (a.title) return a.title;
  if (a.role === 'sub') return a.name;
  const m = a.name.match(/^(claude|codex|pi|devin|terminal)(?:-(\d+))?$/);
  if (!m) return a.name;
  return `${LABELS[m[1] === 'terminal' ? 'shell' : m[1]]}${m[2] ? ` ${m[2]}` : ''}`;
}

/** Zeron's clockwise ring order for its 2×3 mini spinner, row by row. */
const RING = [0, 1, 5, 2, 4, 3];

/** Status slot, as in Zeron: snake spinner while working, check when done, dot otherwise. */
function RowStatus({ status }: { status: Agent['status'] }) {
  let mark;
  if (status === 'done') mark = <Icon.Check size={11} className="rail-check" />;
  else if (status === 'working' || status === 'starting')
    mark = (
      <span className="rail-spin">
        {RING.map(k => (
          <i key={k} style={{ animationDelay: `${(-k / 6) * 750}ms` }} />
        ))}
      </span>
    );
  else mark = <span className={`rail-dot rail-dot-${status}`} />;
  return <span className="rail-status">{mark}</span>;
}

/** Types the name out when it appears or changes; each letter fades in like Zeron's streaming veil. */
function TypedName({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const t = setInterval(() => setN(k => (k >= text.length ? (clearInterval(t), k) : k + 1)), 30);
    return () => clearInterval(t);
  }, [text]);
  return (
    <span className="rail-agent-name">
      {[...text.slice(0, n)].map((c, i) => (
        <span key={i} className="rail-char">
          {c}
        </span>
      ))}
    </span>
  );
}

function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

type Menu = { agent: Agent; x: number; y: number; copy: boolean };

function editAgent(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
  return api(`/api/agents/${id}`, { method: 'PATCH', body: patch });
}

/** Right-click menu for a row, after Zeron's: Rename, Pin, Archive, Copy ▸, Delete. */
function RowMenu({ menu, setMenu, onRename }: { menu: Menu; setMenu: (m: Menu | null) => void; onRename: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState(false);
  const a = menu.agent;
  useEffect(() => {
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', esc);
    };
  }, [setMenu]);
  const run = (fn: () => unknown) => () => {
    void fn();
    setMenu(null);
  };
  const copy = (text: string) => run(() => navigator.clipboard.writeText(text));
  const top = Math.min(menu.y, window.innerHeight - 200);
  return (
    <div className="row-menu" ref={box} style={{ left: menu.x, top }}>
      {menu.copy ? (
        <>
          <button onClick={() => setMenu({ ...menu, copy: false })}>
            <Icon.Chevron size={14} className="flip" /> Back
          </button>
          <button onClick={copy(labelFor(a))}>Title</button>
          <button onClick={copy(agentRef(a).trim())}>Agent reference</button>
          <button onClick={copy(a.cwd)}>Folder path</button>
          <button onClick={copy(`bismind attach ${a.name}`)}>Attach command</button>
        </>
      ) : (
        <>
          <button onClick={run(() => onRename(a.id))}>
            <Icon.Pen size={14} /> Rename…
          </button>
          <button onClick={run(() => editAgent(a.id, { pinned: !a.pinned }))}>
            <Icon.Pin size={14} /> {a.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            onClick={run(() => {
              setHidden(a.id, !a.archived);
              return editAgent(a.id, { archived: !a.archived });
            })}
          >
            <Icon.Archive size={14} /> {a.archived ? 'Unarchive' : 'Archive'}
          </button>
          <button onClick={() => setMenu({ ...menu, copy: true })}>
            <Icon.Copy size={14} /> <span className="grow">Copy</span> <Icon.Chevron size={13} />
          </button>
          <div className="row-menu-sep" />
          {confirm ? (
            <button className="danger" onClick={run(() => api(`/api/agents/${a.id}`, { method: 'DELETE' }))}>
              <Icon.Trash size={14} /> Stop and delete{a.role === 'main' ? ' (with its sub-agents)' : ''}
            </button>
          ) : (
            <button className="danger" onClick={() => setConfirm(true)}>
              <Icon.Trash size={14} /> Delete…
            </button>
          )}
        </>
      )}
    </div>
  );
}

function RenameInput({ agent, done }: { agent: Agent; done: () => void }) {
  const [value, setValue] = useState(labelFor(agent));
  const save = () => {
    if (value.trim() && value.trim() !== labelFor(agent)) void editAgent(agent.id, { title: value });
    done();
  };
  return (
    <input
      className="rail-rename"
      autoFocus
      value={value}
      spellCheck={false}
      onFocus={e => e.target.select()}
      onClick={e => e.stopPropagation()}
      onChange={e => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') done();
      }}
    />
  );
}

function AgentRow({ agent, depth, all, onMenu, renaming, doneRenaming }: { agent: Agent; depth: number; all: Agent[]; onMenu: (m: Menu) => void; renaming: string | null; doneRenaming: () => void }) {
  const focused = useStore(s => s.focusedId === agent.id);
  const hidden = useStore(s => s.hidden.includes(agent.id));
  const kids = all.filter(a => a.parentId === agent.id);
  const open = () => showAgent(agent);
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className={`rail-agent ${focused ? 'on' : ''} ${hidden ? 'rail-agent-hidden' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={open}
        onKeyDown={e => e.key === 'Enter' && e.target === e.currentTarget && open()}
        title={`${agent.task ?? agent.cwd}\n\nDrag into a terminal to reference this agent.`}
        draggable
        onDragStart={e => dragAgent(e, agent)}
        onContextMenu={e => {
          e.preventDefault();
          onMenu({ agent, x: e.clientX, y: e.clientY, copy: false });
        }}
      >
        <RowStatus status={agent.status} />
        {depth > 0 && <span className="rail-branch">↳</span>}
        <HarnessIcon id={agent.harness} size={13} className="rail-harness" />
        {renaming === agent.id ? <RenameInput agent={agent} done={doneRenaming} /> : <TypedName text={labelFor(agent)} />}
        {agent.pinned && <Icon.Pin size={11} className="rail-pin" />}
        <span className="rail-ago">{ago(agent.updatedAt)}</span>
        <button
          className="rail-eye"
          title={hidden ? 'Show pane' : 'Hide pane (keeps running)'}
          onClick={e => {
            e.stopPropagation();
            setHidden(agent.id, !hidden);
          }}
        >
          {hidden ? <Icon.Eye size={12} /> : <Icon.EyeOff size={12} />}
        </button>
      </div>
      {kids.map(k => (
        <AgentRow key={k.id} agent={k} depth={depth + 1} all={all} onMenu={onMenu} renaming={renaming} doneRenaming={doneRenaming} />
      ))}
    </>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const settings = useStore(s => s.settings)!;
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

export function Rail({ onNew }: { onNew: () => void }) {
  const settings = useStore(s => s.settings);
  const agents = useStore(s => s.agents);
  const pinned = useStore(s => s.pinned);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!settings) return null;
  const rowProps = { onMenu: setMenu, renaming, doneRenaming: () => setRenaming(null) };
  const archived = agents.filter(a => a.archived);
  const archivedOpen = collapsed.archived === false;

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
          const inWs = agents.filter(a => !a.archived && workspaceOf(a, settings.workspaces, agents) === g.id);
          // Pinned rows first, then in creation order.
          const roots = inWs.filter(a => !a.parentId || !inWs.some(p => p.id === a.parentId)).sort((x, y) => Number(!!y.pinned) - Number(!!x.pinned));
          const active = settings.activeWorkspace === g.id;
          const open = active ? collapsed[String(g.id)] !== true : collapsed[String(g.id)] === false;
          const live = inWs.filter(a => !['exited', 'error'].includes(a.status)).length;
          return (
            <div key={String(g.id)}>
              <div className={`rail-ws ${active ? 'on' : ''}`} onClick={() => void patchSettings({ activeWorkspace: g.id })} title={g.path}>
                <span className="rail-ws-name">{g.name}</span>
                <button
                  className="rail-remove"
                  title={`New agent in ${g.name}`}
                  onClick={async e => {
                    e.stopPropagation();
                    if (!active) await patchSettings({ activeWorkspace: g.id });
                    onNew();
                  }}
                >
                  <Icon.Plus size={12} />
                </button>
                {g.id && !active && (
                  <button
                    className={`rail-remove ${pinned.includes(g.id) ? 'rail-pinned' : ''}`}
                    title={pinned.includes(g.id) ? 'Stop showing beside the current workspace' : 'Show beside the current workspace'}
                    onClick={e => {
                      e.stopPropagation();
                      setPinned(g.id!, !pinned.includes(g.id!));
                    }}
                  >
                    <Icon.Columns size={12} />
                  </button>
                )}
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
              {open && roots.map(a => <AgentRow key={a.id} agent={a} depth={0} all={inWs} {...rowProps} />)}
            </div>
          );
        })}
        {archived.length > 0 && (
          <div>
            <div className="rail-ws" onClick={() => setCollapsed(c => ({ ...c, archived: archivedOpen }))}>
              <span className="rail-ws-name">Archived</span>
              <span className={`rail-caret ${archivedOpen ? 'open' : ''}`}>
                <Icon.Chevron size={12} />
              </span>
            </div>
            {archivedOpen && archived.map(a => <AgentRow key={a.id} agent={a} depth={0} all={[]} {...rowProps} />)}
          </div>
        )}
      </nav>
      {menu && <RowMenu menu={menu} setMenu={setMenu} onRename={setRenaming} />}
      <footer className="rail-foot">
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
        <button className={`account ${settingsOpen ? 'on' : ''}`} onClick={() => setSettingsOpen(o => !o)} title="Settings">
          <Icon.Gear size={15} />
          <span>Settings</span>
        </button>
        <button className="icon-btn" title={dark ? 'Light mode' : 'Dark mode'} onClick={() => patchUi({ theme: dark ? 'light' : 'dark' })}>
          {dark ? <Icon.Moon size={15} /> : <Icon.Sun size={15} />}
        </button>
      </footer>
    </aside>
  );
}
