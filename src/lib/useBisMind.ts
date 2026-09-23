import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, socket, type CanvasState, type Cli, type Pane, type SpawnRequest } from './api';

export function useBisMind() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [clis, setClis] = useState<Cli[]>([]);
  const [state, setState] = useState<CanvasState>({ workspaces: [], layout: 'stack', sidebarHidden: false, paneWorkspace: {} });
  const [focusId, setFocusId] = useState<string>('');
  const [maximized, setMaximized] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const fresh = useRef<Set<string>>(new Set());

  useEffect(() => {
    socket.connect();
    const off = socket.onFrame(frame => {
      if (frame.type === 'hello') {
        setPanes(frame.panes);
        setState(frame.state);
        setReady(true);
        setConnection('online');
        return;
      }
      if (frame.type === 'created') {
        fresh.current.add(frame.pane.id);
        setPanes(prev => (prev.some(p => p.id === frame.pane.id) ? prev : [...prev, frame.pane]));
        setFocusId(frame.pane.id);
        return;
      }
      if (frame.type === 'closed') {
        setPanes(prev => prev.filter(p => p.id !== frame.paneId));
        setFocusId(prev => (prev === frame.paneId ? '' : prev));
        setMaximized(prev => (prev === frame.paneId ? null : prev));
        return;
      }
      if (frame.type === 'status') {
        setPanes(prev => prev.map(p => (p.id === frame.paneId ? { ...p, status: frame.status, exitCode: frame.exitCode } : p)));
      }
    });
    api<{ clis: Cli[] }>('/clis')
      .then(data => setClis(data.clis))
      .catch(err => {
        setConnection('offline');
        setError(`Pane server unreachable — start it with \`pnpm dev\` (${String(err.message ?? err)})`);
      });
    api<CanvasState>('/state')
      .then(next => {
        setState(next);
        setConnection('online');
      })
      .catch(() => setConnection('offline'));
    return () => {
      off();
    };
  }, []);

  const focused = useMemo(() => panes.find(p => p.id === focusId) ?? null, [panes, focusId]);

  const spawn = useCallback(
    async (req: SpawnRequest) => {
      try {
        const { pane } = await api<{ pane: Pane }>('/panes', { method: 'POST', body: { cols: 110, rows: 30, ...req } });
        setPanes(prev => (prev.some(p => p.id === pane.id) ? prev : [...prev, pane]));
        setFocusId(pane.id);
        if (req.parentId) {
          setState(prev => {
            const parentWs = prev.paneWorkspace[req.parentId as string] ?? prev.paneWorkspace[pane.id];
            const next = { ...prev, paneWorkspace: { ...prev.paneWorkspace, [pane.id]: parentWs ?? workspaceForCwd(prev, req.cwd) } };
            void api('/state', { method: 'PATCH', body: next });
            return next;
          });
        }
        return pane;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [focused],
  );

  const kill = useCallback(async (id: string) => {
    try {
      await api(`/panes/${id}`, { method: 'DELETE' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setPanes(prev => prev.filter(p => p.id !== id));
  }, []);

  const persist = useCallback((patch: Partial<CanvasState>) => {
    setState(prev => {
      const next = { ...prev, ...patch };
      void api('/state', { method: 'PATCH', body: next });
      return next;
    });
  }, []);

  const assign = useCallback(
    (paneId: string, workspaceId: string) => {
      setState(prev => {
        const next = { ...prev, paneWorkspace: { ...prev.paneWorkspace, [paneId]: workspaceId } };
        void api('/state', { method: 'PATCH', body: next });
        return next;
      });
    },
    [],
  );

  const addWorkspace = useCallback(async (path: string, name?: string) => {
    const workspace = await api<{ id: string; name: string; path: string }>('/workspaces', { method: 'POST', body: { path, name } });
    setState(prev => ({ ...prev, workspaces: prev.workspaces.some(w => w.id === workspace.id) ? prev.workspaces : [...prev.workspaces, workspace] }));
    return workspace;
  }, []);

  const removeWorkspace = useCallback(async (id: string) => {
    await api(`/workspaces/${id}`, { method: 'DELETE' });
    setState(prev => ({ ...prev, workspaces: prev.workspaces.filter(w => w.id !== id) }));
  }, []);

  const retry = useCallback(async () => {
    setConnection('connecting');
    try {
      const [cliData, nextState] = await Promise.all([api<{ clis: Cli[] }>('/clis'), api<CanvasState>('/state')]);
      setClis(cliData.clis);
      setState(nextState);
      setConnection('online');
      setReady(true);
    } catch (err) {
      setConnection('offline');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return {
    ready,
    connection,
    retry,
    panes,
    clis,
    state,
    focusId,
    focused,
    maximized,
    error,
    setError,
    setFocusId,
    setMaximized,
    spawn,
    kill,
    persist,
    assign,
    addWorkspace,
    removeWorkspace,
    isFresh: (id: string) => fresh.current.has(id),
    clearFresh: (id: string) => fresh.current.delete(id),
  };
}

export function workspaceForCwd(state: CanvasState, cwd?: string): string {
  if (!cwd) return state.workspaces[0]?.id ?? '';
  const match = [...state.workspaces].sort((a, b) => b.path.length - a.path.length).find(w => cwd === w.path || cwd.startsWith(`${w.path}/`));
  return match?.id ?? state.workspaces[0]?.id ?? '';
}

export function panesOfWorkspace(panes: Pane[], state: CanvasState, workspaceId: string): Pane[] {
  return panes.filter(p => (state.paneWorkspace[p.id] ?? workspaceForCwd(state, p.cwd)) === workspaceId);
}
