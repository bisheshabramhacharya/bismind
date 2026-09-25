import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { type DragEvent, memo, useEffect, useRef, useState } from 'react';
import { AGENT_DRAG_TYPE, term, useStore } from '../lib/store';

const DARK = {
  background: '#141414',
  foreground: '#e7e7e9',
  cursor: '#e7e7e9',
  cursorAccent: '#141414',
  selectionBackground: '#3b5bdb66',
  black: '#1c1c1e',
  red: '#ff6b6b',
  green: '#5fd38d',
  yellow: '#f5c451',
  blue: '#6ea8fe',
  magenta: '#c79bff',
  cyan: '#56d4dd',
  white: '#d6d6d8',
  brightBlack: '#6b6b70',
  brightRed: '#ff8787',
  brightGreen: '#7ee2a8',
  brightYellow: '#ffd978',
  brightBlue: '#8fbcff',
  brightMagenta: '#d9b8ff',
  brightCyan: '#7fe3ea',
  brightWhite: '#ffffff',
};

const LIGHT = {
  background: '#ffffff',
  foreground: '#1f1f1f',
  cursor: '#1f1f1f',
  cursorAccent: '#ffffff',
  selectionBackground: '#2f5fe833',
  black: '#1f1f1f',
  red: '#c42b1c',
  green: '#16803c',
  yellow: '#9a6700',
  blue: '#1f5fd6',
  magenta: '#8b3fd9',
  cyan: '#0f7b8a',
  white: '#6b6b6b',
  brightBlack: '#8a8a8a',
  brightRed: '#d73a2a',
  brightGreen: '#1a9146',
  brightYellow: '#b07800',
  brightBlue: '#2f6fed',
  brightMagenta: '#9a50e6',
  brightCyan: '#138c9c',
  brightWhite: '#2a2a2a',
};

/** App shortcuts that must reach the window even while a terminal has focus. */
export function isAppShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey) return false;
  return ['b', 'j', 'k'].includes(e.key.toLowerCase());
}

/** Flush at once past this many queued chars, so a burst never becomes one huge, janky write. */
const QUEUE_LIMIT = 256 * 1024;

// Opt-in latency samples (queued → parsed by xterm): localStorage.setItem('bismind:terminal-perf', '1'), then read window.__bismindTerminalPerf.
const perfOn = (() => {
  try {
    return localStorage.getItem('bismind:terminal-perf') === '1';
  } catch {
    return false;
  }
})();
const perfSamples: { agentId: string; chars: number; latencyMs: number }[] = [];
if (perfOn) (window as any).__bismindTerminalPerf = perfSamples;
function sample(agentId: string, chars: number, queuedAt: number) {
  perfSamples.push({ agentId, chars, latencyMs: performance.now() - queuedAt });
  if (perfSamples.length > 200) perfSamples.shift();
}

// Re-rendered only when the agent or focus changes; onFocus is read through a ref.
export const Terminal = memo(TerminalView, (a, b) => a.agentId === b.agentId && a.focused === b.focused);

function TerminalView({ agentId, focused, onFocus: onFocusProp }: { agentId: string; focused: boolean; onFocus: () => void }) {
  const onFocusRef = useRef(onFocusProp);
  onFocusRef.current = onFocusProp;
  const onFocus = () => onFocusRef.current();
  const host = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const theme = useStore(s => s.settings?.ui.theme ?? 'dark');
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    const el = host.current!;
    const xterm = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      letterSpacing: 0,
      theme: theme === 'light' ? LIGHT : DARK,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 0, // tmux owns scrollback (mouse wheel scrolls it)
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      drawBoldTextInBrightColors: false,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    xterm.open(el);
    xtermRef.current = xterm;
    // GPU renderer; on context loss (e.g. too many panes) fall back to the default renderer.
    let webgl: WebglAddon | null = null;
    const glFrame = requestAnimationFrame(() => {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = null;
        });
        xterm.loadAddon(webgl);
      } catch {
        webgl = null;
      }
    });
    xterm.attachCustomKeyEventHandler(e => !isAppShortcut(e));

    const safeFit = () => {
      if (!el.offsetWidth || !el.offsetHeight) return;
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
    };
    safeFit();

    // Replayed history contains old terminal queries; xterm's answers to them must not
    // reach the agent as keystrokes. Mute input while a snapshot is being written.
    let replaying = false;

    // Batch output: every frame for the focused pane, 4×/s for background panes, nothing while the
    // window is hidden. A hidden backlog past QUEUE_LIMIT is dropped and re-fetched as a snapshot.
    let queue = '';
    let queuedAt = 0;
    let stale = false;
    let timer: number | null = null;
    const cancel = () => {
      if (timer !== null) cancelAnimationFrame(timer), clearTimeout(timer);
      timer = null;
    };
    const flush = () => {
      cancel();
      if (!queue) return;
      const data = queue;
      const at = queuedAt;
      queue = '';
      xterm.write(data, perfOn ? () => sample(agentId, data.length, at) : undefined);
    };
    const onVisible = () => {
      if (document.hidden) return;
      if (stale) {
        stale = false;
        term.resync(agentId);
      } else flush();
    };
    document.addEventListener('visibilitychange', onVisible);
    const detach = term.attach(
      agentId,
      {
        write: data => {
          if (stale) return;
          if (!queue) queuedAt = performance.now();
          queue += data;
          if (document.hidden) {
            if (queue.length >= QUEUE_LIMIT) (stale = true), (queue = '');
            return;
          }
          if (queue.length >= QUEUE_LIMIT) return flush();
          if (timer !== null) return;
          timer = focusedRef.current ? requestAnimationFrame(flush) : window.setTimeout(flush, 250);
        },
        reset: snapshot => {
          cancel();
          queue = '';
          stale = false;
          replaying = true;
          xterm.reset();
          xterm.write(snapshot, () => {
            replaying = false;
          });
        },
      },
      xterm.cols,
      xterm.rows,
    );

    // Device-attribute replies (ESC[?…c / ESC[>…c) are answers to tmux's own probes, which tmux
    // has long since stopped waiting for; forwarded late they show up as typed junk.
    const DA_REPLY = /\x1b\[[?>=][\d;]*c/g;
    const forward = (data: string) => {
      if (replaying) return;
      const clean = data.replace(DA_REPLY, '');
      if (clean) term.input(agentId, clean);
    };
    const input = xterm.onData(forward);
    const bin = xterm.onBinary(forward);
    // Hidden/collapsed panes measure tiny; never push those sizes to the agent's terminal.
    const resized = xterm.onResize(({ cols, rows }) => {
      if (!document.hidden && el.offsetWidth > 240 && el.offsetHeight > 100) term.resize(agentId, cols, rows);
    });
    const ro = new ResizeObserver(() => safeFit());
    ro.observe(el);

    return () => {
      ro.disconnect();
      input.dispose();
      bin.dispose();
      resized.dispose();
      detach();
      cancel();
      document.removeEventListener('visibilitychange', onVisible);
      cancelAnimationFrame(glFrame);
      webgl?.dispose();
      xterm.dispose();
      xtermRef.current = null;
    };
  }, [agentId]);

  useEffect(() => {
    if (focused) xtermRef.current?.focus();
  }, [focused]);

  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = theme === 'light' ? LIGHT : DARK;
  }, [theme]);

  // Another agent dragged here: paste its reference (as a paste, so harness prompts don't treat "@" as a keystroke).
  const isAgentDrag = (e: DragEvent) => e.dataTransfer.types.includes(AGENT_DRAG_TYPE);
  return (
    <div
      className={`terminal ${dropping ? 'terminal-drop' : ''}`}
      ref={host}
      onMouseDown={onFocus}
      onDragOver={e => {
        if (!isAgentDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={e => {
        setDropping(false);
        if (!isAgentDrag(e)) return;
        e.preventDefault();
        if (e.dataTransfer.getData(AGENT_DRAG_TYPE) === agentId) return;
        xtermRef.current?.paste(e.dataTransfer.getData('text/plain'));
        onFocus();
        xtermRef.current?.focus();
      }}
    />
  );
}
