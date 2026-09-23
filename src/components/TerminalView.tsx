import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { socket, type Pane } from '../lib/api';

interface Props {
  pane: Pane;
  focused: boolean;
}

const THEME = {
  background: '#141414',
  foreground: '#fafafa',
  cursor: '#5c8fff',
  cursorAccent: '#141414',
  selectionBackground: '#ffffff26',
  black: '#1c1c1c',
  red: '#ff6568',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#5c8fff',
  magenta: '#af87ff',
  cyan: '#5cc8ff',
  white: '#d4d4d4',
  brightBlack: '#858585',
  brightRed: '#ff8b8d',
  brightGreen: '#86efac',
  brightYellow: '#fcd34d',
  brightBlue: '#93b8ff',
  brightMagenta: '#c9b1ff',
  brightCyan: '#9fdcff',
  brightWhite: '#fafafa',
};

/**
 * One real terminal per pane. The focused pane writes straight through; panes
 * running in the background are batched to a low frame rate so twenty agents
 * cannot melt the browser.
 */
export function TerminalView({ pane, focused }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const pending = useRef<string[]>([]);
  const flushTimer = useRef<number | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const terminal = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: focused,
      scrollback: 2000,
      allowProposedApi: true,
      theme: THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(element);
    term.current = terminal;
    fit.current = fitAddon;

    const safeFit = () => {
      try {
        fitAddon.fit();
      } catch {
        /* element not laid out yet */
      }
    };
    safeFit();
    socket.attach(pane.id, terminal.cols, terminal.rows);

    const disposeInput = terminal.onData(data => socket.input(pane.id, data));
    const disposeResize = terminal.onResize(({ cols, rows }) => socket.resize(pane.id, cols, rows));

    const flush = () => {
      flushTimer.current = null;
      const terminalRef = term.current;
      if (!terminalRef || !pending.current.length) return;
      const chunk = pending.current.join('');
      pending.current = [];
      terminalRef.write(chunk);
    };

    const off = socket.onFrame(frame => {
      if (frame.type === 'snapshot' && frame.paneId === pane.id) {
        terminal.reset();
        if (frame.data) terminal.write(frame.data);
        return;
      }
      if (frame.type === 'data' && frame.paneId === pane.id) {
        if (focusedRef.current) {
          terminal.write(frame.data);
        } else {
          pending.current.push(frame.data);
          if (flushTimer.current === null) flushTimer.current = window.setTimeout(flush, 250);
        }
      }
    });

    const observer = new ResizeObserver(() => {
      safeFit();
      socket.resize(pane.id, terminal.cols, terminal.rows);
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      off();
      disposeInput.dispose();
      disposeResize.dispose();
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      socket.detach(pane.id);
      terminal.dispose();
      term.current = null;
    };
  }, [pane.id]);

  useEffect(() => {
    const terminal = term.current;
    if (!terminal) return;
    terminal.options.cursorBlink = focused;
    if (focused) {
      terminal.focus();
      try {
        fit.current?.fit();
      } catch {
        /* ignore */
      }
    }
  }, [focused]);

  return <div className="bm-term" ref={host} />;
}
