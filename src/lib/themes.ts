/**
 * Themes and accent colors. A theme's UI tokens live in app.css under [data-theme=<id>];
 * its terminal colors live here. The accent replaces the theme's own highlight color.
 */
import type { ITheme } from '@xterm/xterm';
import type { Settings } from './types';

export interface Theme {
  id: string;
  label: string;
  scheme: 'dark' | 'light';
  term: ITheme;
}

const DARK: ITheme = {
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

const LIGHT: ITheme = {
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

export const THEMES: Theme[] = [
  { id: 'dark', label: 'Dark', scheme: 'dark', term: DARK },
  { id: 'light', label: 'Light', scheme: 'light', term: LIGHT },
  {
    id: 'midnight',
    label: 'Midnight',
    scheme: 'dark',
    term: { ...DARK, background: '#0d1322', foreground: '#e6ebf5', cursor: '#e6ebf5', cursorAccent: '#0d1322', black: '#1a2233', blue: '#7aa2ff', white: '#d0d7e6', brightBlack: '#5b6680' },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    scheme: 'dark',
    term: { ...DARK, background: '#232326', foreground: '#e6e6e8', cursor: '#e6e6e8', cursorAccent: '#232326', black: '#2c2c30', brightBlack: '#77777d' },
  },
  {
    id: 'nord',
    label: 'Nord',
    scheme: 'dark',
    term: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#88c0d055',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#d08770',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    scheme: 'light',
    term: {
      background: '#fbf8f1',
      foreground: '#2b2620',
      cursor: '#2b2620',
      cursorAccent: '#fbf8f1',
      selectionBackground: '#c26a2e33',
      black: '#2b2620',
      red: '#b3261e',
      green: '#3d7a3a',
      yellow: '#8a6100',
      blue: '#2d5fa8',
      magenta: '#8a3f9e',
      cyan: '#1f7a7a',
      white: '#6b6255',
      brightBlack: '#8a7f6f',
      brightRed: '#c53a2e',
      brightGreen: '#4a8f47',
      brightYellow: '#a17200',
      brightBlue: '#3a6fbf',
      brightMagenta: '#9c50b0',
      brightCyan: '#2a8c8c',
      brightWhite: '#3a332a',
    },
  },
];

export interface Accent {
  id: string;
  label: string;
  /** Tuned per scheme: brighter on dark themes, deeper on light ones. */
  dark: string;
  light: string;
}

export const ACCENTS: Accent[] = [
  { id: 'blue', label: 'Blue', dark: '#4f7cff', light: '#2f5fe8' },
  { id: 'violet', label: 'Violet', dark: '#9b87ff', light: '#6d4fe0' },
  { id: 'pink', label: 'Pink', dark: '#ff6ba6', light: '#c2185b' },
  { id: 'orange', label: 'Orange', dark: '#ff8f45', light: '#c2410c' },
  { id: 'green', label: 'Green', dark: '#3fcf86', light: '#15803d' },
  { id: 'teal', label: 'Teal', dark: '#2dd4bf', light: '#0f766e' },
];

/** The two settings that decide colors. */
type Look = Partial<Pick<Settings['ui'], 'theme' | 'accent'>> | undefined;

export function themeOf(id: string | undefined): Theme {
  return THEMES.find(t => t.id === id) ?? THEMES[0];
}

export function accentColor(ui: Look): string | null {
  const accent = ACCENTS.find(a => a.id === ui?.accent);
  return accent ? accent[themeOf(ui?.theme).scheme] : null;
}

/** Put the theme and accent on the page. */
export function applyTheme(ui: Look) {
  const theme = themeOf(ui?.theme);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.scheme = theme.scheme;
  const accent = accentColor(ui);
  for (const v of ['--blue', '--focus']) {
    if (accent) root.style.setProperty(v, accent);
    else root.style.removeProperty(v);
  }
}

/** The terminal palette for the current theme, with the accent's selection color. */
export function terminalTheme(ui: Look): ITheme {
  const theme = themeOf(ui?.theme);
  const accent = accentColor(ui);
  return accent ? { ...theme.term, selectionBackground: `${accent}${theme.scheme === 'dark' ? '66' : '33'}` } : theme.term;
}
