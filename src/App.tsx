import { useEffect, useState } from 'react';
import { Canvas, PickerModal } from './components/Canvas';
import { Dashboard } from './components/Dashboard';
import { Icon } from './components/Icons';
import { Rail } from './components/Rail';
import { TOKEN, getState, patchUi, useStore } from './lib/store';

const LAYOUTS = ['stack', 'grid', 'columns'] as const;

function TopBar() {
  const ui = useStore(s => s.settings?.ui);
  const needsYou = useStore(s => s.agents.filter(a => a.status === 'waiting').length);
  if (!ui) return <div className="topbar" />;
  const nextLayout = LAYOUTS[(LAYOUTS.indexOf(ui.layout) + 1) % LAYOUTS.length];
  return (
    <div className="topbar">
      <div className="topbar-group">
        <button className={`icon-btn ${ui.rail ? 'on' : ''}`} title="Workspaces  ⌘B" onClick={() => patchUi({ rail: !ui.rail })}>
          <Icon.SidebarLeft size={17} />
        </button>
      </div>
      <div className="topbar-group">
        <button className={`icon-btn ${ui.showSubagents ? 'on' : ''}`} title={`${ui.showSubagents ? 'Hide' : 'Show'} sub-agent panes  ⌘J`} onClick={() => patchUi({ showSubagents: !ui.showSubagents })}>
          <Icon.Agents size={16} />
        </button>
        <button className="icon-btn" title={`Layout: ${ui.layout} → ${nextLayout}`} onClick={() => patchUi({ layout: nextLayout })}>
          <Icon.Grid size={16} />
        </button>
        <button className={`icon-btn ${ui.dashboard ? 'on' : ''}`} title="Dashboard  ⇧⌘B" onClick={() => patchUi({ dashboard: !ui.dashboard })}>
          <Icon.SidebarRight size={17} />
          {needsYou > 0 && !ui.dashboard && <span className="topbar-badge" />}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const settings = useStore(s => s.settings);
  const connected = useStore(s => s.connected);
  const loaded = useStore(s => s.loaded);
  const [picker, setPicker] = useState(false);
  const theme = settings?.ui.theme ?? 'dark';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    // Dropping a file or text outside a terminal must not navigate the window away.
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const ui = getState().settings?.ui;
      if (!ui) return;
      const k = e.key.toLowerCase();
      if (k === 'b' && e.shiftKey) (e.preventDefault(), patchUi({ dashboard: !ui.dashboard }));
      else if (k === 'b') (e.preventDefault(), patchUi({ rail: !ui.rail }));
      else if (k === 'j') (e.preventDefault(), patchUi({ showSubagents: !ui.showSubagents }));
      else if (k === 'k') (e.preventDefault(), setPicker(true));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!TOKEN) {
    return (
      <div className="gate">
        <h2>Open BisMind from your terminal</h2>
        <p>
          Run <code>bismind</code>. It opens this window with your access token.
        </p>
      </div>
    );
  }
  if (!loaded || !settings) {
    return (
      <div className="gate">
        <p>{connected ? 'Loading…' : 'Connecting to BisMind…'}</p>
        {!connected && (
          <p className="muted">
            If this sticks, run <code>bismind up</code>.
          </p>
        )}
      </div>
    );
  }

  const ws = settings.workspaces.find(w => w.id === settings.activeWorkspace) ?? null;
  return (
    <div className="app">
      <TopBar />
      {!connected && <div className="offline">Reconnecting to BisMind… your agents keep running.</div>}
      <main className={`main ${settings.ui.rail ? '' : 'no-rail'} ${settings.ui.dashboard ? '' : 'no-dash'}`}>
        {settings.ui.rail && <Rail onNew={() => setPicker(true)} />}
        <Canvas onNew={() => setPicker(true)} />
        {settings.ui.dashboard && <Dashboard />}
      </main>
      {picker && <PickerModal workspace={ws} onClose={() => setPicker(false)} />}
    </div>
  );
}
