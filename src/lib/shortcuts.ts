/**
 * App shortcuts, in one place: the window's handler and the terminals (which must let them
 * through) both read this, so a new shortcut can't work in one and not the other.
 */
export type Shortcut = 'rail' | 'dashboard' | 'subagents' | 'new';

export function appShortcut(e: KeyboardEvent): Shortcut | null {
  if (!e.metaKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'b') return e.shiftKey ? 'dashboard' : 'rail';
  if (k === 'j') return 'subagents';
  if (k === 'k') return 'new';
  return null;
}
