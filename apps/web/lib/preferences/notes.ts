import { z } from 'zod';

/**
 * Per-user note appearance (`user_preferences.notes_json`, plan D-59): the paper, the font and
 * the size of the text of every note, apart from the terminal's own settings. Browser-safe: the
 * notes view and the settings preview read the same values and helpers.
 */

/** `auto` is the D-58 look that follows the interface theme; the others hold in both themes. */
export const NOTE_PAPERS = ['auto', 'paper', 'slate', 'contrast'] as const;
export type NotePaper = (typeof NOTE_PAPERS)[number];

/** `mono` is the Code role (JetBrains Mono); `sans` is the interface's text face. */
export const NOTE_FONTS = ['mono', 'sans'] as const;
export type NoteFont = (typeof NOTE_FONTS)[number];

export const NOTE_FONT_SIZE_MIN = 12;
export const NOTE_FONT_SIZE_MAX = 20;
/** A phone zooms in on a field set under 16 px, so a note's text never goes below it there. */
export const NOTE_PHONE_FONT_SIZE_MIN = 16;
export const NOTE_LINE_HEIGHT = 1.5;

/** Strict shape of a submitted form (the settings action). */
export const NotesPreferencesInput = z.object({
  paper: z.enum(NOTE_PAPERS),
  font: z.enum(NOTE_FONTS),
  fontSize: z.number().int().min(NOTE_FONT_SIZE_MIN).max(NOTE_FONT_SIZE_MAX),
});
export type NotesPreferences = z.infer<typeof NotesPreferencesInput>;

export const DEFAULT_NOTES_PREFERENCES: NotesPreferences = {
  paper: 'auto',
  font: 'mono',
  fontSize: 14,
};

const D = DEFAULT_NOTES_PREFERENCES;

/** Lenient shape for stored JSON: each unknown or invalid field falls back to its default. */
const StoredNotesPreferences = z.object({
  paper: z.enum(NOTE_PAPERS).catch(D.paper),
  font: z.enum(NOTE_FONTS).catch(D.font),
  fontSize: z.number().int().min(NOTE_FONT_SIZE_MIN).max(NOTE_FONT_SIZE_MAX).catch(D.fontSize),
});

/** Stored `notes_json` → preferences; anything unreadable becomes the defaults. */
export function parseNotesPreferences(json: string | null | undefined): NotesPreferences {
  let value: unknown = {};
  try {
    value = json ? JSON.parse(json) : {};
  } catch {
    value = {};
  }
  const parsed = StoredNotesPreferences.safeParse(
    value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  );
  return parsed.success ? parsed.data : { ...D };
}

// ── papers ───────────────────────────────────────────────────────────────────

/**
 * The tokens a paper redefines inside a note (globals.css, `[data-note-paper="…"]`), so the
 * text, notices, buttons, the empty card, the footer, the delete slip and the rename field all
 * follow it without colours of their own. `color-scheme` comes with them.
 */
export const NOTE_PAPER_TOKENS = [
  'note',
  'ink',
  'ink-muted',
  'ink-faint',
  'line',
  'line-strong',
  'line-hover',
  'surface',
  'surface-raised',
  'surface-pressed',
  'surface-solid',
  'field',
  'accent',
  'accent-strong',
  'accent-soft',
  'accent-ring',
  'on-accent',
  'focus',
  'selection',
  'danger',
  'danger-soft',
  'warning-soft',
  'info-soft',
  'success-soft',
  'attention',
] as const;

export type FixedNotePaper = Exclude<NotePaper, 'auto'>;

export interface NotePaperPalette {
  /** The interface palette every other token is taken from: the light block or `@theme`. */
  base: 'light' | 'dark';
  note: string;
  ink: string;
  inkMuted: string;
  line: string;
}

/**
 * What each paper changes from its base palette (globals.css holds the full rule; a test keeps
 * the two equal and checks the ink's contrast on the page from these values).
 */
export const NOTE_PAPER_PALETTES: Record<FixedNotePaper, NotePaperPalette> = {
  paper: {
    base: 'light',
    note: '#fbf6e6',
    ink: '#241f14',
    inkMuted: '#5f5640',
    line: 'rgb(36 31 20 / 0.14)',
  },
  slate: {
    base: 'dark',
    note: '#2c3340',
    ink: '#e8ecf2',
    inkMuted: '#aab3c2',
    line: 'rgb(255 255 255 / 0.1)',
  },
  contrast: {
    base: 'light',
    note: '#ffffff',
    ink: '#000000',
    inkMuted: '#3d3d3d',
    line: 'rgb(0 0 0 / 0.18)',
  },
};

/**
 * The Automatic paper in both interface themes, for its card's swatch (split on the diagonal):
 * `--color-note`, `--color-ink` and `--color-ink-muted` of `@theme` and of the light block.
 */
export const NOTE_AUTO_SWATCH = {
  dark: { note: '#363066', ink: '#f2f0fb', inkMuted: '#aba7cb' },
  light: { note: '#ffffff', ink: '#171431', inkMuted: '#565277' },
} as const;

/** The `data-note-paper` value of a note's scope; none for Automatic (the interface's own). */
export function notePaperAttribute(paper: NotePaper): FixedNotePaper | undefined {
  return paper === 'auto' ? undefined : paper;
}

/** A note's text: the face (mono keeps the terminal's word spacing) and its size. */
export function noteTextLook(
  { font, fontSize }: Pick<NotesPreferences, 'font' | 'fontSize'>,
  phone: boolean,
): { className: string; style: { fontSize: string; lineHeight: number } } {
  const size = phone ? Math.max(fontSize, NOTE_PHONE_FONT_SIZE_MIN) : fontSize;
  return {
    className: font === 'mono' ? 'terminal-text font-mono' : 'font-sans',
    style: { fontSize: `${size}px`, lineHeight: NOTE_LINE_HEIGHT },
  };
}
