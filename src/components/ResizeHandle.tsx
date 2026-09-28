import type { CSSProperties, PointerEvent } from 'react';
import { patchUi } from '../lib/store';

/** Width limits per side panel. Dragging well past the minimum hides the panel (⌘B / ⇧⌘B bring it back). */
const PANELS = {
  rail: { min: 170, max: 480, initial: 236, cssVar: '--rail-w', width: 'railWidth', shown: 'rail' },
  dash: { min: 260, max: 560, initial: 320, cssVar: '--dash-w', width: 'dashWidth', shown: 'dashboard' },
} as const;
const HIDE_PAST = 70;

/** The CSS variables that size the side panels in `.main`. */
export function panelWidths(ui: { railWidth?: number; dashWidth?: number }): CSSProperties {
  return { [PANELS.rail.cssVar]: `${ui.railWidth ?? PANELS.rail.initial}px`, [PANELS.dash.cssVar]: `${ui.dashWidth ?? PANELS.dash.initial}px` } as CSSProperties;
}

/** A drag handle on a side panel's inner edge. Double-click resets the width. */
export function ResizeHandle({ panel }: { panel: keyof typeof PANELS }) {
  const p = PANELS[panel];
  const start = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const aside = handle.parentElement!;
    const main = aside.closest<HTMLElement>('.main')!;
    const startX = e.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    let width = startWidth;
    let hide = false;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    document.body.classList.add('resizing');
    // Move the grid directly while dragging; the setting is saved once, on release.
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - startX;
      const raw = panel === 'rail' ? startWidth + dx : startWidth - dx;
      hide = raw < p.min - HIDE_PAST;
      width = Math.round(Math.min(p.max, Math.max(p.min, raw)));
      main.style.setProperty(p.cssVar, `${width}px`);
      aside.style.opacity = hide ? '0.35' : '';
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      aside.style.opacity = '';
      if (hide) {
        main.style.setProperty(p.cssVar, `${startWidth}px`);
        patchUi({ [p.shown]: false });
      } else if (width !== startWidth) patchUi({ [p.width]: width });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end, { once: true });
    handle.addEventListener('pointercancel', end, { once: true });
  };
  return (
    <div
      className={`resize resize-${panel === 'rail' ? 'right' : 'left'}`}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onPointerDown={start}
      onDoubleClick={() => patchUi({ [p.width]: p.initial })}
    />
  );
}
