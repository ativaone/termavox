import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTES_PREFERENCES,
  NOTE_AUTO_SWATCH,
  NOTE_FONTS,
  NOTE_PAPER_PALETTES,
  NOTE_PAPER_TOKENS,
  NOTE_PAPERS,
  type NotePaperPalette,
  NotesPreferencesInput,
  notePaperAttribute,
  noteTextLook,
  parseNotesPreferences,
} from '../../lib/preferences/notes.ts';

const CSS = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

/** The declarations of the first rule whose selector line is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const end = CSS.indexOf('}', start);
  const body = CSS.slice(start + selector.length + 2, end);
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/^\s*([\w-]+):\s*([^;]+);/gm)) {
    declarations.set(match[1] as string, (match[2] as string).trim());
  }
  return declarations;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('notes preferences (plan D-59)', () => {
  it('defaults to the interface look, monospace, 14 px', () => {
    expect(DEFAULT_NOTES_PREFERENCES).toEqual({ paper: 'auto', font: 'mono', fontSize: 14 });
    expect(NOTE_PAPERS).toEqual(['auto', 'paper', 'slate', 'contrast']);
    expect(NOTE_FONTS).toEqual(['mono', 'sans']);
  });

  it('reads stored JSON leniently: each bad field falls back on its own', () => {
    for (const bad of [null, undefined, '', '{not json', '[]', '"paper"', 'null', '42']) {
      expect(parseNotesPreferences(bad), String(bad)).toEqual(DEFAULT_NOTES_PREFERENCES);
    }
    expect(parseNotesPreferences('{"paper":"velvet","font":"serif","fontSize":99}')).toEqual(
      DEFAULT_NOTES_PREFERENCES,
    );
    expect(parseNotesPreferences('{"paper":"slate","fontSize":13.5}')).toEqual({
      ...DEFAULT_NOTES_PREFERENCES,
      paper: 'slate',
    });
    expect(parseNotesPreferences('{"font":"sans","fontSize":"16"}')).toEqual({
      ...DEFAULT_NOTES_PREFERENCES,
      font: 'sans',
    });
    expect(parseNotesPreferences('{"paper":"contrast","font":"sans","fontSize":20}')).toEqual({
      paper: 'contrast',
      font: 'sans',
      fontSize: 20,
    });
    expect(parseNotesPreferences('{"fontSize":12,"extra":true}')).toEqual({
      ...DEFAULT_NOTES_PREFERENCES,
      fontSize: 12,
    });
  });

  it('accepts only known papers and fonts and whole sizes from 12 to 20 when saving', () => {
    const ok = (value: unknown) => NotesPreferencesInput.safeParse(value).success;
    for (const paper of NOTE_PAPERS) {
      for (const font of NOTE_FONTS) {
        expect(ok({ paper, font, fontSize: 12 })).toBe(true);
        expect(ok({ paper, font, fontSize: 20 })).toBe(true);
      }
    }
    const base = { ...DEFAULT_NOTES_PREFERENCES };
    expect(ok({ ...base, paper: 'velvet' })).toBe(false);
    expect(ok({ ...base, font: 'serif' })).toBe(false);
    expect(ok({ ...base, fontSize: 11 })).toBe(false);
    expect(ok({ ...base, fontSize: 21 })).toBe(false);
    expect(ok({ ...base, fontSize: 14.5 })).toBe(false);
    expect(ok({ ...base, fontSize: Number.NaN })).toBe(false);
    expect(ok({ paper: 'auto', font: 'mono' })).toBe(false);
  });

  it('scopes a paper by attribute, and none for Automatic', () => {
    expect(notePaperAttribute('auto')).toBeUndefined();
    expect(notePaperAttribute('paper')).toBe('paper');
    expect(notePaperAttribute('slate')).toBe('slate');
    expect(notePaperAttribute('contrast')).toBe('contrast');
  });

  it("sets the text's face and size, never under 16 px on a phone", () => {
    expect(noteTextLook({ font: 'mono', fontSize: 14 }, false)).toEqual({
      className: 'terminal-text font-mono',
      style: { fontSize: '14px', lineHeight: 1.5 },
    });
    // The interface face keeps its word spacing: no terminal-text.
    expect(noteTextLook({ font: 'sans', fontSize: 12 }, false)).toEqual({
      className: 'font-sans',
      style: { fontSize: '12px', lineHeight: 1.5 },
    });
    expect(noteTextLook({ font: 'mono', fontSize: 12 }, true).style.fontSize).toBe('16px');
    expect(noteTextLook({ font: 'sans', fontSize: 18 }, true).style.fontSize).toBe('18px');
  });
});

describe('note papers in globals.css', () => {
  const bases = { dark: block('@theme static'), light: block(':root[data-theme="light"]') };

  for (const [paper, palette] of Object.entries(NOTE_PAPER_PALETTES) as [
    string,
    NotePaperPalette,
  ][]) {
    it(`${paper}: the model's page, inks and line over its base palette, nothing else`, () => {
      const base = bases[palette.base];
      const own: Record<string, string> = {
        note: palette.note,
        ink: palette.ink,
        'ink-muted': palette.inkMuted,
        line: palette.line,
      };
      const expected = new Map<string, string>([
        ['color-scheme', palette.base],
        ...NOTE_PAPER_TOKENS.map((token): [string, string] => {
          const value = own[token] ?? base.get(`--color-${token}`);
          if (value === undefined) throw new Error(`${palette.base} has no --color-${token}`);
          return [`--color-${token}`, value];
        }),
      ]);
      const rule = block(`[data-note-paper="${paper}"]`);
      expect(Object.fromEntries(rule)).toEqual(Object.fromEntries(expected));
    });

    it(`${paper}: ink at 7:1 or better on its page, muted ink at 4.5:1 or better`, () => {
      expect(contrast(palette.ink, palette.note)).toBeGreaterThanOrEqual(7);
      expect(contrast(palette.inkMuted, palette.note)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('comes after both light-theme blocks', () => {
    const lastTheme = CSS.indexOf('  :root[data-theme="system"] {');
    expect(lastTheme).toBeGreaterThan(CSS.indexOf(':root[data-theme="light"] {'));
    for (const paper of Object.keys(NOTE_PAPER_PALETTES)) {
      expect(CSS.indexOf(`[data-note-paper="${paper}"] {`)).toBeGreaterThan(lastTheme);
    }
  });

  it("draws Automatic's swatch with the interface's own note page and inks", () => {
    for (const theme of ['dark', 'light'] as const) {
      const swatch = NOTE_AUTO_SWATCH[theme];
      expect(swatch.note, theme).toBe(bases[theme].get('--color-note'));
      expect(swatch.ink, theme).toBe(bases[theme].get('--color-ink'));
      expect(swatch.inkMuted, theme).toBe(bases[theme].get('--color-ink-muted'));
      expect(contrast(swatch.ink, swatch.note)).toBeGreaterThanOrEqual(7);
      expect(contrast(swatch.inkMuted, swatch.note)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
