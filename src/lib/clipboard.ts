/**
 * Clipboard access for every terminal and input in the app. Inside the native Mac window the
 * clipboard goes through the Swift bridge (WKWebView gates navigator.clipboard behind prompts);
 * in a plain browser it uses navigator.clipboard.
 */
import type { Terminal as XTerm } from '@xterm/xterm';

type Bridge = { postMessage(msg: unknown): Promise<unknown> };
const bridge = (): Bridge | undefined => (window as any).webkit?.messageHandlers?.bismindClipboard;

const terminals = new Map<Element, XTerm>();

/** Lets Cmd+C / Cmd+V (native menu) and Ctrl+Shift+C/V find the terminal that has focus. */
export function registerTerminal(xterm: XTerm): () => void {
  const key = xterm.textarea!;
  terminals.set(key, xterm);
  return () => void terminals.delete(key);
}

export async function writeClipboard(text: string) {
  if (!text) return;
  const b = bridge();
  if (b) return void (await b.postMessage({ op: 'write', text }));
  await navigator.clipboard.writeText(text);
}

export async function readClipboard(): Promise<string> {
  const b = bridge();
  if (b) return String((await b.postMessage({ op: 'read' })) ?? '');
  return navigator.clipboard.readText();
}

/** The selected text in whatever has focus: a terminal, a text field, or the page. */
export function selectedText(): string {
  const a = document.activeElement;
  const term = a && terminals.get(a);
  if (term) return term.getSelection();
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
    const { selectionStart: s, selectionEnd: e } = a;
    if (s !== null && e !== null && s !== e) return a.value.slice(s, e);
  }
  return window.getSelection()?.toString() ?? '';
}

/** Paste into whatever has focus. Terminals get a real bracketed paste. */
export function pasteText(text: string) {
  if (!text) return;
  const a = document.activeElement;
  const term = a && terminals.get(a);
  if (term) term.paste(text);
  else if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || (a as HTMLElement | null)?.isContentEditable)
    document.execCommand('insertText', false, text);
}

/** OSC 52 payload ("c;<base64>") → text, or null for clipboard queries and junk. */
export function decodeOsc52(data: string): string | null {
  const payload = data.slice(data.indexOf(';') + 1);
  if (!payload || payload === '?') return null;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

// Called by the Mac window's Edit menu (Cmd+C / Cmd+V).
(window as any).__bismindCopyText = selectedText;
(window as any).__bismindPaste = pasteText;
