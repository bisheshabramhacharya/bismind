import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { type DragEvent, memo, useEffect, useRef, useState } from 'react';
import { decodeOsc52, pasteText, readClipboard, registerTerminal, writeClipboard } from '../lib/clipboard';
import { appShortcut } from '../lib/shortcuts';
import { AGENT_DRAG_TYPE, term, useStore } from '../lib/store';
import { terminalTheme } from '../lib/themes';

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
  const themeId = useStore(s => s.settings?.ui.theme);
  const accent = useStore(s => s.settings?.ui.accent);
  const theme = terminalTheme({ theme: themeId, accent });
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    const el = host.current!;
    const xterm = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      letterSpacing: 0,
      theme: themeRef.current,
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
    const unregister = registerTerminal(xterm);
    // Cmd+C / Cmd+V come from the native Edit menu. Ctrl+Shift+C/V work everywhere, and Ctrl+C
    // copies only while text is selected (otherwise it stays SIGINT).
    xterm.attachCustomKeyEventHandler(e => {
      if (appShortcut(e)) return false;
      if (e.type !== 'keydown' || !e.ctrlKey || e.metaKey || e.altKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && (e.shiftKey || xterm.hasSelection())) {
        e.preventDefault();
        void writeClipboard(xterm.getSelection());
        return false;
      }
      if (k === 'v' && e.shiftKey) {
        e.preventDefault();
        void readClipboard().then(pasteText, () => undefined);
        return false;
      }
      return true;
    });

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

    // tmux (mouse on) owns drag-selection and hands the text to the terminal as OSC 52.
    const osc52 = xterm.parser.registerOscHandler(52, data => {
      const text = replaying ? null : decodeOsc52(data);
      if (text) void writeClipboard(text).catch(() => undefined);
      return true;
    });

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
      osc52.dispose();
      unregister();
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
    if (xtermRef.current) xtermRef.current.options.theme = theme;
  }, [themeId, accent]);

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
