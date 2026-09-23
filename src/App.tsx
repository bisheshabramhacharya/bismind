import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentMark } from './components/AgentMark';
import { TerminalView } from './components/TerminalView';
import { panesOfWorkspace, useBisMind, workspaceForCwd } from './lib/useBisMind';
import type { Pane } from './lib/api';

const STATUS_LABEL: Record<Pane['status'], string> = {
  starting: 'starting',
  working: 'working',
  idle: 'idle',
  exited: 'finished',
  error: 'failed',
};

const STATUS_ORDER: Record<string, number> = { 'needs-you': 0, error: 0, working: 1, starting: 2, idle: 3, exited: 4 };

function shortenPath(path: string) {
  const home = '/Users/';
  const trimmed = path.startsWith(home) ? `~/${path.split('/').slice(2).join('/')}` : path;
  const parts = trimmed.split('/');
  return parts.length > 3 ? `${parts.slice(0, 2).join('/')}/…/${parts.slice(-1)}` : trimmed;
}

function paneState(pane: Pane): 'needs-you' | 'working' | 'idle' | 'exited' | 'error' | 'starting' {
  if (pane.status === 'error' || (pane.exitCode !== null && pane.exitCode !== 0)) return 'error';
  if (pane.status === 'working') return 'working';
  if (pane.status === 'starting') return 'starting';
  if (pane.status === 'exited') return 'exited';
  return 'idle';
}

export default function App() {
  const bm = useBisMind();
  const { panes, clis, state, focusId, maximized } = bm;
  const [pickerWorkspace, setPickerWorkspace] = useState<string | null>(null);
  const [inspector, setInspector] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [newPath, setNewPath] = useState('');
  const [addingWs, setAddingWs] = useState(false);
  const [toast, setToast] = useState('');
  const [dashboardOpen, setDashboardOpen] = useState(true);
  const [activeWs, setActiveWs] = useState('');

  const workspaces = state.workspaces;
  const activeWorkspaceId = useMemo(() => {
    if (activeWs && workspaces.some(w => w.id === activeWs)) return activeWs;
    const ofFocus = state.paneWorkspace[focusId];
    if (ofFocus && workspaces.some(w => w.id === ofFocus)) return ofFocus;
    const firstWithPanes = workspaces.find(w => panesOfWorkspace(panes, state, w.id).length > 0);
    return firstWithPanes?.id ?? workspaces[0]?.id ?? '';
  }, [activeWs, state, focusId, panes, workspaces]);

  useEffect(() => {
    if (bm.error) {
      setToast(bm.error);
      bm.setError('');
      const timer = window.setTimeout(() => setToast(''), 7000);
      return () => window.clearTimeout(timer);
    }
  }, [bm.error]);

  const pickerOpen = pickerWorkspace !== null;
  const pickerWs = workspaces.find(w => w.id === pickerWorkspace) ?? workspaces.find(w => w.id === activeWorkspaceId);
  const workspacePanes = useMemo(() => panesOfWorkspace(panes, state, activeWorkspaceId), [panes, state, activeWorkspaceId]);
  const layout = state.layout;
  const visiblePanes = maximized ? workspacePanes.filter(p => p.id === maximized) : workspacePanes;
  const columns = useMemo(() => {
    if (layout === 'split' || visiblePanes.length <= 1) {
      const half = Math.ceil(visiblePanes.length / 2);
      return [visiblePanes.slice(0, half), visiblePanes.slice(half)].filter(column => column.length);
    }
    const roots = visiblePanes.filter(p => !p.parentId || !visiblePanes.some(o => o.id === p.parentId));
    const rest = visiblePanes.filter(p => !roots.includes(p));
    return [roots, rest].filter(column => column.length);
  }, [layout, visiblePanes]);

  const availableClis = clis;

  const focusPane = (id: string) => {
    bm.setFocusId(id);
    const owner = state.paneWorkspace[id] ?? workspaceForCwd(state, panes.find(p => p.id === id)?.cwd);
    if (owner) setActiveWs(owner);
  };

  const launch = async (cliId: string, options: { model?: string; provider?: string; prompt?: string } = {}) => {
    const ws = pickerWs ?? workspaces.find(w => w.id === activeWorkspaceId);
    const pane = await bm.spawn({
      cli: cliId,
      cwd: ws?.path,
      prompt: options.prompt ?? null,
      headed: true,
      model: options.model || null,
      provider: options.provider || null,
    });
    if (pane) {
      if (ws) bm.assign(pane.id, ws.id);
      setPickerWorkspace(null);
      setModel('');
      setProvider('');
    }
  };

  const addWorkspace = async () => {
    const path = newPath.trim();
    if (!path) return;
    try {
      const ws = await bm.addWorkspace(path.replace(/^~/, '/Users/bishesha'));
      setNewPath('');
      setAddingWs(false);
      setActiveWs(ws.id);
      setPickerWorkspace(ws.id);
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err));
    }
  };

  // Keyboard: ⌘B toggles the rail, ⇧⌘B the dashboard, ⌘T opens the picker, Esc closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (event.shiftKey) setDashboardOpen(open => !open);
        else bm.persist({ sidebarHidden: !state.sidebarHidden });
      }
      if (meta && event.key.toLowerCase() === 't') {
        event.preventDefault();
        setPickerWorkspace(activeWorkspaceId);
      }
      if (event.key === 'Escape') {
        setPickerWorkspace(null);
        setInspector(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeWorkspaceId, bm, state.sidebarHidden]);

  const grouped = useMemo(() => {
    const rows = panes.map(p => ({ pane: p, group: paneState(p) === 'error' ? 'needs-you' : paneState(p) }));
    rows.sort((a, b) => (STATUS_ORDER[a.group] ?? 9) - (STATUS_ORDER[b.group] ?? 9));
    return rows;
  }, [panes]);

  return (
    <div className="bm-stage">
      <div className="bm-titlebar">
        <span className="bm-lights" aria-hidden>
          <span className="bm-light" data-role="close" />
          <span className="bm-light" data-role="min" />
          <span className="bm-light" data-role="zoom" />
        </span>
        <span className="bm-brand">
          <span className="bm-brand-mark">B</span>
          BisMind
        </span>
        <span className="bm-titlebar-spacer" />
        <div className="bm-modes" role="group" aria-label="Mode">
          <div className="bm-modes-track">
            <span className="bm-mode-thumb" style={{ ['--i' as string]: 0 }} />
            <button className="bm-mode" data-on="true" type="button">Code</button>
            <button className="bm-mode" type="button" disabled title="Agent mode is not built">Agent</button>
            <button className="bm-mode" type="button" disabled title="Thread mode is not built">Thread</button>
          </div>
        </div>
        <span className="bm-titlebar-spacer" />
        <span className="bm-chrome-band">
          <button
            className="bm-chrome-btn"
            data-on={layout === 'split'}
            title="Change pane layout (stack / split)"
            aria-label="Change pane layout"
            type="button"
            onClick={() => bm.persist({ layout: layout === 'stack' ? 'split' : 'stack' })}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button
            className="bm-chrome-btn"
            data-on={!state.sidebarHidden}
            title="Toggle sidebar (⌘B)"
            aria-label="Toggle sidebar"
            type="button"
            onClick={() => bm.persist({ sidebarHidden: !state.sidebarHidden })}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
          <button
            className="bm-chrome-btn"
            data-on={dashboardOpen}
            title="Toggle dashboard (⇧⌘B)"
            aria-label="Toggle dashboard"
            type="button"
            onClick={() => setDashboardOpen(open => !open)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="4" width="8" height="16" rx="2" />
              <rect x="14" y="4" width="7" height="7" rx="2" />
              <rect x="14" y="14" width="7" height="6" rx="2" />
            </svg>
          </button>
        </span>
      </div>

      <div className="bm-body">
        <aside className="bm-sidebar" data-hidden={state.sidebarHidden}>
          <div className="bm-list-header">
            <span>Workspaces</span>
            <button className="bm-row-mini" title="Add a folder" aria-label="Add workspace" type="button" onClick={() => setAddingWs(value => !value)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>

          {addingWs ? (
            <div className="bm-row" style={{ paddingBottom: 8 }}>
              <input
                className="bm-input"
                autoFocus
                placeholder="/path/to/folder"
                value={newPath}
                onChange={event => setNewPath(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void addWorkspace();
                }}
              />
            </div>
          ) : null}

          <div className="bm-rail-list bm-scroll">
            {workspaces.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: '11px' }} className="bm-phead-meta">
                No folders yet — press + and paste a path.
              </div>
            ) : null}
            {workspaces.map(workspace => {
              const wsPanes = panesOfWorkspace(panes, state, workspace.id);
              const roots = wsPanes.filter(p => !p.parentId);
              const isActive = workspace.id === activeWorkspaceId;
              return (
                <div key={workspace.id}>
                  <div className="bm-ws-head">
                    <button
                      className="bm-row"
                      data-on={isActive}
                      type="button"
                      title={workspace.path}
                      onClick={() => {
                        setActiveWs(workspace.id);
                        setPickerWorkspace(null);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ width: 'calc(var(--u) * 11)', height: 'calc(var(--u) * 11)' }}>
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                      </svg>
                      <span className="bm-row-label">{workspace.name}</span>
                      {wsPanes.length ? <span className="bm-row-badge">{wsPanes.length}</span> : null}
                    </button>
                    <button
                      className="bm-row-mini"
                      title={`New pane in ${workspace.name}`}
                      aria-label={`New pane in ${workspace.name}`}
                      type="button"
                      onClick={() => setPickerWorkspace(workspace.id)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    </button>
                  </div>

                  {roots.map(root => (
                    <PaneTree
                      key={root.id}
                      pane={root}
                      panes={wsPanes}
                      active={focusId === root.id}
                      onFocus={focusPane}
                      onClose={id => bm.kill(id)}
                    />
                  ))}
                </div>
              );
            })}
          </div>

          <div className="bm-side-foot">
            <span>
              <kbd>⌘T</kbd> new pane · <kbd>⌘B</kbd> rail · <kbd>⇧⌘B</kbd> dashboard
            </span>
            <span style={{ fontFamily: 'var(--face-mono)' }}>{panes.length} pane{panes.length === 1 ? '' : 's'} live</span>
          </div>
        </aside>

        <section className="bm-canvas" aria-label="Pane canvas">
          {bm.connection !== 'online' ? (
            <div className="bm-empty">
              <svg className="bm-empty-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
                <path d="M12 3v10M12 17.5v.5" />
                <circle cx="12" cy="12" r="9" />
              </svg>
              <div className="bm-empty-copy">
                <h3 className="bm-empty-title">Pane server {bm.connection === 'connecting' ? 'starting…' : 'offline'}</h3>
                <p className="bm-empty-lead">
                  The terminals live in the pane server, not the browser. Start it in the project folder:
                </p>
                <p className="bm-form-foot">
                  <code>cd {bm.state.workspaces[0]?.path ?? '/Users/bishesha/Documents/BisMind'} &amp;&amp; pnpm dev</code>
                </p>
              </div>
              <button className="bm-launch-card" type="button" onClick={() => void bm.retry()}>
                <span className="bm-launch-name">Retry connection</span>
              </button>
            </div>
          ) : pickerOpen || workspacePanes.length === 0 ? (
            <LaunchPicker
              title={pickerWs?.name ?? 'this workspace'}
              clis={availableClis}
              model={model}
              provider={provider}
              onModel={setModel}
              onProvider={setProvider}
              onCancel={workspacePanes.length ? () => setPickerWorkspace(null) : undefined}
              onLaunch={cli => void launch(cli, { model, provider })}
            />
          ) : maximized ? (
            <div className="bm-col">
              <button className="bm-restore" type="button" onClick={() => bm.setMaximized(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 3v18" />
                </svg>
                Restore split layout
              </button>
              {visiblePanes.map(pane => (
                <PaneCell
                  key={pane.id}
                  pane={pane}
                  parent={panes.find(p => p.id === pane.parentId) ?? null}
                  focused
                  fresh={bm.isFresh(pane.id)}
                  onDone={() => bm.clearFresh(pane.id)}
                  onFocus={() => focusPane(pane.id)}
                  onMaximize={() => bm.setMaximized(null)}
                  onAdd={workspacePanes.length < 6 ? () => setPickerWorkspace(activeWorkspaceId) : undefined}
                  onClose={() => bm.kill(pane.id)}
                  onInspect={() => setInspector(pane.id)}
                  inspector={inspector === pane.id}
                />
              ))}
            </div>
          ) : (
            columns.map((column, index) => (
              <div className="bm-col" key={index}>
                {column.map(pane => (
                  <PaneCell
                    key={pane.id}
                    pane={pane}
                    parent={panes.find(p => p.id === pane.parentId) ?? null}
                    focused={pane.id === focusId || (column.length === 1 && workspacePanes.length === 1)}
                    fresh={bm.isFresh(pane.id)}
                    onDone={() => bm.clearFresh(pane.id)}
                    onFocus={() => focusPane(pane.id)}
                    onMaximize={() => bm.setMaximized(pane.id === maximized ? null : pane.id)}
                    onAdd={workspacePanes.length < 6 ? () => setPickerWorkspace(activeWorkspaceId) : undefined}
                    onClose={() => bm.kill(pane.id)}
                    onInspect={() => setInspector(pane.id)}
                    inspector={inspector === pane.id}
                  />
                ))}
              </div>
            ))
          )}
        </section>

        {dashboardOpen ? (
          <aside className="bm-sidebar" style={{ width: 'calc(var(--u) * 210)' }}>
            <div className="bm-list-header">
              <span>Dashboard</span>
              <span className="bm-row-badge">{panes.length}</span>
            </div>
            <div className="bm-rail-list bm-scroll">
              {['needs-you', 'working', 'starting', 'idle', 'exited'].map(group => {
                const rows = grouped.filter(row => row.group === group);
                if (!rows.length) return null;
                return (
                  <div key={group}>
                    <div className="bm-phead-meta" style={{ padding: '10px 8px 4px', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                      {group === 'needs-you' ? 'Needs you' : group} {rows.length}
                    </div>
                    {rows.map(({ pane }) => (
                      <button
                        key={pane.id}
                        className="bm-row"
                        data-on={focusId === pane.id}
                        type="button"
                        title={`${pane.title} — ${pane.cwd}`}
                        onClick={() => focusPane(pane.id)}
                      >
                        <AgentMark cli={pane.cli} accent={pane.accent} className="bm-launch-mark" />
                        <span className="bm-row-label">
                          {pane.title}
                          <span className="bm-phead-meta" style={{ display: 'block' }}>
                            {pane.parentId ? 'sub-agent · ' : ''}
                            {shortenPath(pane.cwd)}
                          </span>
                        </span>
                        <span className="bm-dot" data-state={paneState(pane)} />
                      </button>
                    ))}
                  </div>
                );
              })}
              {panes.length === 0 ? (
                <div className="bm-phead-meta" style={{ padding: '10px 8px' }}>
                  No panes yet. Press ⌘T to open one.
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      {toast ? <div className="bm-toast">{toast}</div> : null}
    </div>
  );
}

function PaneTree({
  pane,
  panes,
  active,
  onFocus,
  onClose,
}: {
  pane: Pane;
  panes: Pane[];
  active: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const children = panes.filter(p => p.parentId === pane.id);
  return (
    <>
      <button
        className="bm-row bm-row-indent"
        data-on={active}
        type="button"
        title={`${pane.title} — ${pane.cwd}`}
        onClick={() => onFocus(pane.id)}
      >
        <AgentMark cli={pane.cli} accent={pane.accent} className="bm-launch-mark" />
        <span className="bm-row-label">{pane.title}</span>
        <span className="bm-row-trailing">
          <span className="bm-dot" data-state={paneState(pane)} title={STATUS_LABEL[pane.status]} />
          <span
            className="bm-row-mini"
            role="button"
            tabIndex={-1}
            title="Close pane"
            onClick={event => {
              event.stopPropagation();
              onClose(pane.id);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </span>
        </span>
      </button>
      {children.length ? (
        <div className="bm-line">
          {children.map(child => (
            <PaneTree key={child.id} pane={child} panes={panes} active={false} onFocus={onFocus} onClose={onClose} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function LaunchPicker({
  title,
  clis,
  model,
  provider,
  onModel,
  onProvider,
  onLaunch,
  onCancel,
}: {
  title: string;
  clis: { id: string; label: string; available: boolean; accent: string; hint: string; providers?: string[]; modelArg?: boolean }[];
  model: string;
  provider: string;
  onModel: (value: string) => void;
  onProvider: (value: string) => void;
  onLaunch: (cli: string) => void;
  onCancel?: () => void;
}) {
  const anyProviders = clis.some(cli => cli.providers?.length);
  return (
    <div className="bm-empty">
      {onCancel ? (
        <button className="bm-picker-cancel" type="button" onClick={onCancel} style={{ alignSelf: 'flex-end' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          Back to workspace
        </button>
      ) : null}
      <svg className="bm-empty-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
        <rect x="3" y="3" width="18" height="7" rx="1.5" />
        <rect x="3" y="14" width="8" height="7" rx="1.5" />
        <rect x="15" y="14" width="6" height="7" rx="1.5" />
      </svg>
      <div className="bm-empty-copy">
        <h3 className="bm-empty-title">Open an agent pane in {title}</h3>
        <p className="bm-empty-lead">
          Real CLI agents in real terminals. Pick one to start it in this folder, and any agent can open others as
          sub-agents — visible panes, nested in the rail.
        </p>
      </div>

      <div className="bm-model-row">
        {anyProviders ? (
          <select className="bm-select" value={provider} onChange={event => onProvider(event.target.value)} title="Provider" style={{ flex: '0 0 auto' }}>
            <option value="">provider…</option>
            {[...new Set(clis.flatMap(cli => cli.providers ?? []))].sort().map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        ) : null}
        <input
          className="bm-input"
          placeholder="model (optional, e.g. gpt-5, deepseek-chat)"
          value={model}
          onChange={event => onModel(event.target.value)}
        />
      </div>

      <div className="bm-launch-grid">
        {clis.map(cli => (
          <button
            key={cli.id}
            className="bm-launch-card"
            type="button"
            data-missing={!cli.available}
            title={cli.available ? `Open ${cli.label}` : `Not installed — ${cli.hint}`}
            onClick={() => (cli.available ? onLaunch(cli.id) : undefined)}
          >
            <AgentMark cli={cli.id} accent={cli.accent} className="bm-launch-mark" />
            <span className="bm-launch-name">{cli.label}</span>
            {cli.available && (model || provider) && cli.modelArg ? <span className="bm-row-badge">model</span> : null}
          </button>
        ))}
      </div>
      <p className="bm-form-foot">
        These run the real CLIs on your PATH. A model you type is passed with the CLI's own flag — <code>pi --provider … --model …</code>, <code>codex --model …</code>.
      </p>
      {clis.some(cli => !cli.available) ? (
        <p className="bm-form-foot">
          Missing: {clis.filter(cli => !cli.available).map(cli => `${cli.label} (${cli.hint})`).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

function PaneCell({
  pane,
  parent,
  focused,
  fresh,
  inspector,
  onFocus,
  onMaximize,
  onAdd,
  onClose,
  onInspect,
  onDone,
}: {
  pane: Pane;
  parent: Pane | null;
  focused: boolean;
  fresh: boolean;
  inspector: boolean;
  onFocus: () => void;
  onMaximize: () => void;
  onAdd?: () => void;
  onClose: () => void;
  onInspect: () => void;
  onDone: () => void;
}) {
  const state = paneState(pane);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!fresh) return;
    const timer = window.setTimeout(onDone, 900);
    return () => window.clearTimeout(timer);
  }, [fresh, onDone]);

  return (
    <div className="bm-cell" data-focus={focused} data-fresh={fresh} onMouseDown={onFocus} role="presentation" style={{ position: 'relative' }}>
      <div className="bm-phead">
        <AgentMark cli={pane.cli} accent={pane.accent} className="bm-phead-mark" />
        <div className="bm-phead-center">
          <span className="bm-phead-title">{pane.title}</span>
          {parent ? (
            <span className="bm-parent-chip" title={`Spawned by ${parent.title}`}>
              ↳ from {parent.title}
            </span>
          ) : null}
          <span className="bm-phead-meta">{shortenPath(pane.cwd)}</span>
        </div>
        <div className="bm-phead-actions">
          <button className="bm-pbtn" type="button" aria-label="More" title="Pane details" onClick={onInspect}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
          </button>
          <button className="bm-pbtn" type="button" aria-label="Full screen" title="Focus this pane" onClick={onMaximize}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 3H3v6M15 21h6v-6M21 9V3h-6M3 15v6h6" /></svg>
          </button>
          <button className="bm-pbtn" type="button" aria-label="New pane" title={onAdd ? 'New pane' : 'Pane limit reached (6)'} disabled={!onAdd} onClick={onAdd}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button className="bm-pbtn" data-role="destructive" type="button" aria-label="Close pane" title="Close pane" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </div>

      <TerminalView pane={pane} focused={focused} />

      <div className="bm-pfoot" data-state={state}>
        <span>{STATUS_LABEL[pane.status]}{pane.exitCode !== null ? ` · exit ${pane.exitCode}` : ''}</span>
        <span>{pane.model ? `${pane.provider ? `${pane.provider}/` : ''}${pane.model}` : pane.cliLabel}</span>
        <span style={{ marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%' }}>{pane.command}</span>
      </div>

      {inspector ? (
        <div className="bm-inspector" ref={popRef}>
          <strong>{pane.title}</strong>
          <span className="bm-mono">{pane.cwd}</span>
          <span className="bm-mono">{pane.headed ? 'headed terminal' : 'headless run'} · {pane.mode}</span>
          {pane.prompt ? <span className="bm-mono">prompt: {pane.prompt.slice(0, 160)}</span> : null}
          <button data-action type="button" onClick={onMaximize}>Focus this pane</button>
          <button data-action type="button" onClick={onInspect}>Back to session</button>
        </div>
      ) : null}
    </div>
  );
}
