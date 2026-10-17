import { z } from 'zod';

/**
 * Per-user terminal preferences (`user_preferences.terminal_json`, plan §8.1 /settings/terminal).
 * Rendering-only options: nothing here changes buffer state, so the server emulator ignores them
 * (scrollback is set per server). Browser-safe: the terminal client reads the same
 * schema, fonts and colour schemes.
 */

export const TERMINAL_FONTS = ['jetbrains-mono', 'system', 'cascadia-code', 'fira-code'] as const;
export type TerminalFont = (typeof TERMINAL_FONTS)[number];

/** CSS font stacks. JetBrains Mono is bundled (OFL); the others render only where installed. */
export const TERMINAL_FONT_STACKS: Record<TerminalFont, string> = {
  'jetbrains-mono': 'var(--font-jetbrains), "JetBrains Mono", ui-monospace, monospace',
  system: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
  'cascadia-code': '"Cascadia Code", "Cascadia Mono", ui-monospace, monospace',
  'fira-code': '"Fira Code", "Fira Mono", ui-monospace, monospace',
};

export const TERMINAL_SCHEMES = ['board', 'slate', 'buff', 'contrast'] as const;
export type TerminalScheme = (typeof TERMINAL_SCHEMES)[number];

/** An xterm.js `ITheme` subset (all colours as hex). */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Colour schemes. The default (`board`, the scheme id is stored per user and kept) is the
 * near-black pane of the night cabin under plain ink, with the accent as the cursor and
 * selection; then a lighter violet-navy, a light paper sheet, and a plain high-contrast scheme.
 */
export const TERMINAL_THEMES: Record<TerminalScheme, TerminalTheme> = {
  board: {
    background: '#0c0b16',
    foreground: '#ebe9f5',
    cursor: '#4cc9ff',
    cursorAccent: '#0c0b16',
    selectionBackground: '#274a66',
    black: '#1c1936',
    red: '#e5736a',
    green: '#73c08e',
    yellow: '#e2c074',
    blue: '#72a6e0',
    magenta: '#c49ad8',
    cyan: '#63bfc4',
    white: '#c9d3de',
    brightBlack: '#5b6e86',
    brightRed: '#ff8a80',
    brightGreen: '#93dbab',
    brightYellow: '#f2d793',
    brightBlue: '#93c0f3',
    brightMagenta: '#dbb5ec',
    brightCyan: '#86d9dd',
    brightWhite: '#f4f7fa',
  },
  slate: {
    background: '#171431',
    foreground: '#ebe9f5',
    cursor: '#4cc9ff',
    cursorAccent: '#171431',
    selectionBackground: '#2d4f6e',
    black: '#110f24',
    red: '#ec7f76',
    green: '#7dc796',
    yellow: '#e6c57d',
    blue: '#7db0e8',
    magenta: '#cba2de',
    cyan: '#6cc6ca',
    white: '#cdd6e0',
    brightBlack: '#6b819e',
    brightRed: '#ff968c',
    brightGreen: '#9de1b3',
    brightYellow: '#f5dc9c',
    brightBlue: '#9cc7f5',
    brightMagenta: '#e0bdef',
    brightCyan: '#8fdee2',
    brightWhite: '#f6f8fb',
  },
  buff: {
    background: '#fbf6e6',
    foreground: '#241f14',
    cursor: '#1a2431',
    cursorAccent: '#fbf6e6',
    selectionBackground: '#f2c46d',
    black: '#241f14',
    red: '#a3271f',
    green: '#2d6e3b',
    yellow: '#7d5a00',
    blue: '#1d5fb4',
    magenta: '#86378b',
    cyan: '#1b6d73',
    white: '#5f5440',
    brightBlack: '#6e6248',
    brightRed: '#bf3a30',
    brightGreen: '#3a8549',
    brightYellow: '#946c00',
    brightBlue: '#2c70c6',
    brightMagenta: '#9d4aa3',
    brightCyan: '#23838a',
    brightWhite: '#8a7d62',
  },
  contrast: {
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#000000',
    selectionBackground: '#4d6a99',
    black: '#000000',
    red: '#ff6b6b',
    green: '#5ff08a',
    yellow: '#ffe066',
    blue: '#74b4ff',
    magenta: '#f08cff',
    cyan: '#5ef2f2',
    white: '#e6e6e6',
    brightBlack: '#8c8c8c',
    brightRed: '#ff9999',
    brightGreen: '#9cffb8',
    brightYellow: '#fff0a3',
    brightBlue: '#a8d1ff',
    brightMagenta: '#f7b8ff',
    brightCyan: '#a3ffff',
    brightWhite: '#ffffff',
  },
};

export const CURSOR_STYLES = ['block', 'bar', 'underline'] as const;
export type CursorStyle = (typeof CURSOR_STYLES)[number];

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;

/** Strict shape of a submitted form (the settings action). */
export const TerminalPreferencesInput = z.object({
  fontFamily: z.enum(TERMINAL_FONTS),
  fontSize: z.number().int().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
  colorScheme: z.enum(TERMINAL_SCHEMES),
  cursorStyle: z.enum(CURSOR_STYLES),
  cursorBlink: z.boolean(),
  copyOnSelect: z.boolean(),
  rightClickPaste: z.boolean(),
  /** OSC 52 clipboard writes from remote programs (plan §10.2: off unless the user opts in). */
  allowOsc52Write: z.boolean(),
  /** Links open only after a confirmation that shows the full URL (default on). */
  confirmLinks: z.boolean(),
});
export type TerminalPreferences = z.infer<typeof TerminalPreferencesInput>;

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  fontFamily: 'jetbrains-mono',
  fontSize: 14,
  colorScheme: 'board',
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
  rightClickPaste: false,
  allowOsc52Write: false,
  confirmLinks: true,
};

const D = DEFAULT_TERMINAL_PREFERENCES;

/** Lenient shape for stored JSON: each unknown or invalid field falls back to its default. */
const StoredTerminalPreferences = z.object({
  fontFamily: z.enum(TERMINAL_FONTS).catch(D.fontFamily),
  fontSize: z.number().int().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).catch(D.fontSize),
  colorScheme: z.enum(TERMINAL_SCHEMES).catch(D.colorScheme),
  cursorStyle: z.enum(CURSOR_STYLES).catch(D.cursorStyle),
  cursorBlink: z.boolean().catch(D.cursorBlink),
  copyOnSelect: z.boolean().catch(D.copyOnSelect),
  rightClickPaste: z.boolean().catch(D.rightClickPaste),
  allowOsc52Write: z.boolean().catch(D.allowOsc52Write),
  confirmLinks: z.boolean().catch(D.confirmLinks),
});

/** Stored `terminal_json` → preferences; anything unreadable becomes the defaults. */
export function parseTerminalPreferences(json: string | null | undefined): TerminalPreferences {
  let value: unknown = {};
  try {
    value = json ? JSON.parse(json) : {};
  } catch {
    value = {};
  }
  const parsed = StoredTerminalPreferences.safeParse(
    value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  );
  return parsed.success ? parsed.data : { ...D };
}
