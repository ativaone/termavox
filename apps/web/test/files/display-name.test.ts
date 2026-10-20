import { isControlChar, isInvisibleFormatChar } from '@termdock/protocol/client';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { Locale } from '../../i18n/locales.ts';
import { displayName, splitNames } from '../../lib/files/display-name.ts';
import en from '../../messages/en.json' with { type: 'json' };
import ptBR from '../../messages/pt-BR.json' with { type: 'json' };

// Every list here is fixed code points, never `\p{…}`: the Node that runs this (a floating 24.x
// in CI) may carry another Unicode version, and the helper's own table is fixed too.

const at = (codePoint: number) => String.fromCodePoint(codePoint);
/** The tooltip's escape for one code point. */
const esc = (codePoint: number) => {
  const hex = codePoint.toString(16).toUpperCase();
  return codePoint > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
};

/** The space separators other than U+0020 (Unicode 17's Zs): hidden wherever they are. */
const SPACES = [
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x202f, 0x205f, 0x3000,
];

/** C0 controls, DEL and C1 controls. */
const CONTROLS = [0x00, 0x07, 0x09, 0x0a, 0x1b, 0x1f, 0x7f, 0x85, 0x9f];

/**
 * The plan's set: soft hyphen, grapheme joiner, Arabic letter mark, zero-width and directional
 * marks, line and paragraph separators, bidi embeddings and overrides, word joiner to the
 * deprecated formats (bidi isolates among them), variation selectors, the BOM.
 */
const FORMATS = [
  0x00ad, 0x034f, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b,
  0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x2066, 0x2067, 0x2068,
  0x2069, 0x206a, 0x206f, 0xfe00, 0xfe0f, 0xfeff,
];

/**
 * Both ends of the helper's other ranges: fillers that draw a blank, Khmer inherent vowels,
 * Mongolian selectors, the braille blank, reserved and interlinear annotation formats, Egyptian,
 * shorthand and musical format controls, tags and the supplementary variation selectors.
 */
const BLANKS = [
  0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f, 0x2800, 0x3164, 0xffa0, 0xfff0, 0xfff8,
  0xfff9, 0xfffb, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0000, 0xe0001, 0xe0020,
  0xe007f, 0xe0100, 0xe01ef, 0xe0fff,
];

/** Format characters that draw a sign (prepended concatenation marks): names may show them. */
const VISIBLE_FORMAT = [
  0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd,
  0x110cd,
];

/**
 * Visible code points, among them both neighbours of every hidden range (assigned or not), so
 * that widening a range by one fails here.
 */
const VISIBLE = [
  0x20, 0x21, 0x2e, 0x30, 0x41, 0x7e, 0xa1, 0xac, 0xae, 0xe9, 0x034e, 0x0350, 0x05d0, 0x061b,
  0x061d, 0x061f, 0x0627, 0x115e, 0x1161, 0x167f, 0x1681, 0x17b3, 0x17b6, 0x180a, 0x1810, 0x1ffe,
  0x1fff, 0x2010, 0x2027, 0x2030, 0x205e, 0x2070, 0x27ff, 0x2801, 0x2ffb, 0x2fff, 0x3001, 0x3163,
  0x3165, 0x4e00, 0xfdfc, 0xfdff, 0xfe10, 0xfefc, 0xfefe, 0xff00, 0xff01, 0xff9f, 0xffa1, 0xffee,
  0xffef, 0xfffc, 0x1342e, 0x1342f, 0x13440, 0x1bc9f, 0x1bca4, 0x1d172, 0x1d17b, 0x1f600, 0xdffff,
  0xe1000,
];

describe('remote file names on screen (plan §5.12)', () => {
  it('shows a bidi override as a placeholder, the escaped name as the tooltip', () => {
    expect(displayName('report\u202Efdp.exe')).toEqual({
      text: 'report\uFFFDfdp.exe',
      title: 'report\\u202Efdp.exe',
    });
  });

  it('shows zero-width characters and control characters', () => {
    expect(displayName('config\u200B')).toEqual({ text: 'config\uFFFD', title: 'config\\u200B' });
    expect(displayName('notes\nold.txt')).toEqual({
      text: 'notes\uFFFDold.txt',
      title: 'notes\\u000Aold.txt',
    });
    expect(displayName('\u202E\u202E')).toEqual({ text: '\uFFFD\uFFFD', title: '\\u202E\\u202E' });
  });

  it('shows spaces at either end, never the spaces inside a name', () => {
    expect(displayName('report.pdf ')).toEqual({
      text: 'report.pdf\uFFFD',
      title: 'report.pdf\\u0020',
    });
    expect(displayName(' a b')).toEqual({ text: '\uFFFDa b', title: '\\u0020a b' });
    expect(displayName('  ')).toEqual({ text: '\uFFFD\uFFFD', title: '\\u0020\\u0020' });
    expect(displayName('my file.txt')).toEqual({ text: 'my file.txt', title: null });
  });

  it('shows every other space separator, inside a name too', () => {
    // A run of them never collapses: it would push ".exe" out of a row cut to its width.
    const name = `invoice.pdf${'\u2003'.repeat(3)}.exe`;
    expect(displayName(name)).toEqual({
      text: 'invoice.pdf\uFFFD\uFFFD\uFFFD.exe',
      title: 'invoice.pdf\\u2003\\u2003\\u2003.exe',
    });
    for (const codePoint of SPACES) {
      expect(displayName(`a${at(codePoint)}b`), codePoint.toString(16)).toEqual({
        text: 'a\uFFFDb',
        title: `a${esc(codePoint)}b`,
      });
      expect(displayName(`${at(codePoint)}ab`).text, codePoint.toString(16)).toBe('\uFFFDab');
    }
  });

  it('replaces every hidden character it knows', () => {
    for (const codePoint of [...CONTROLS, ...FORMATS, ...BLANKS, ...SPACES]) {
      expect(displayName(`config${at(codePoint)}.txt`), codePoint.toString(16)).toEqual({
        text: 'config\uFFFD.txt',
        title: `config${esc(codePoint)}.txt`,
      });
    }
  });

  it('replaces every character the daemon cleans from host text', () => {
    // Both are fixed predicates of the protocol package, not Unicode tables.
    for (let codePoint = 0; codePoint <= 0xffff; codePoint++) {
      if (isControlChar(codePoint) || isInvisibleFormatChar(codePoint)) {
        expect(displayName(`a${at(codePoint)}b`).text, codePoint.toString(16)).toBe('a\uFFFDb');
      }
    }
  });

  it('leaves visible characters, those next to a hidden range included', () => {
    for (const codePoint of [...VISIBLE, ...VISIBLE_FORMAT]) {
      const name = `a${at(codePoint)}b`;
      expect(displayName(name), codePoint.toString(16)).toEqual({ text: name, title: null });
    }
    for (const codePoint of VISIBLE_FORMAT) {
      const name = `${at(codePoint)}12.txt`;
      expect(displayName(name), codePoint.toString(16)).toEqual({ text: name, title: null });
    }
  });

  it('leaves right-to-left, accented, CJK and emoji names as they are', () => {
    // Arabic and Hebrew ("report", "annual report"), Portuguese, Chinese, an emoji: escaped here
    // so that no right-to-left text reorders this line in an editor.
    for (const name of [
      '\u062A\u0642\u0631\u064A\u0631-2026.pdf',
      '\u05D3\u05D5\u05D7 \u05E9\u05E0\u05EA\u05D9.txt',
      'relat\u00F3rio.ods',
      '\u5831\u544A.md',
      '\u{1F600}.png',
    ]) {
      expect(displayName(name)).toEqual({ text: name, title: null });
    }
  });
});

describe('remote names in a sentence (plan §5.12)', () => {
  it('splits a sentence around its names, in the order the sentence has them', () => {
    expect(splitNames(['a', 'b'], (a, b) => `${a} → ${b}`)).toEqual([
      '',
      { name: 'a' },
      ' → ',
      { name: 'b' },
      '',
    ]);
    // A translation may put the names the other way round.
    expect(splitNames(['a', 'b'], (a, b) => `${b} from ${a}.`)).toEqual([
      '',
      { name: 'b' },
      ' from ',
      { name: 'a' },
      '.',
    ]);
    expect(splitNames([], () => 'No names')).toEqual(['No names']);
  });

  it('keeps the raw name, so that drawing it can show what it hides', () => {
    const name = 'report\u202Efdp.exe';
    expect(splitNames([name], (mark) => `Delete ${mark}?`)).toEqual(['Delete ', { name }, '?']);
  });

  it('finds the upload in the proxy notice, in both languages', () => {
    const name = 'big\u202Eosi.exe';
    const title = (messages: typeof en, locale: Locale) => {
      const t = createTranslator({ locale, messages, namespace: 'files.proxy' });
      return splitNames([name], (mark) => t('title', { name: mark }));
    };
    expect(title(en, 'en')).toEqual(['A proxy refused the upload of ', { name }, '']);
    expect(title(ptBR, 'pt-BR')).toEqual(['Um proxy recusou o envio de ', { name }, '']);
  });

  it('finds every name in the other catalog sentences that hold remote names', () => {
    for (const [messages, locale] of [
      [en, 'en'],
      [ptBR, 'pt-BR'],
    ] as const) {
      const t = createTranslator({ locale, messages });
      const sentences = [
        splitNames(['/srv/a'], (target) => t('files.list.linkTo', { target })),
        splitNames(['/srv/a'], (target) => t('files.list.linkMeta', { target })),
        splitNames(['/srv'], (folder) => t('files.conflict.title', { count: 2, folder })),
        splitNames(['a (1).txt'], (name) => t('files.conflict.keepBothHelp', { name })),
        splitNames(['/srv/a', '/srv/b'], (from, to) =>
          t('admin.audit.details.rename', { from, to }),
        ),
      ];
      expect(sentences.map((parts) => parts.filter((part) => typeof part !== 'string'))).toEqual([
        [{ name: '/srv/a' }],
        [{ name: '/srv/a' }],
        [{ name: '/srv' }],
        [{ name: 'a (1).txt' }],
        [{ name: '/srv/a' }, { name: '/srv/b' }],
      ]);
      // No mark is left in the words around the names.
      const words = sentences.flat().filter((part) => typeof part === 'string');
      for (const text of words) {
        expect(
          Array.from(text).some((ch) => isControlChar(ch.codePointAt(0) ?? 0)),
          text,
        ).toBe(false);
      }
    }
  });
});
