import { isControlChar } from '@termavox/protocol/client';

/**
 * Remote file names and paths as the UI shows them (plan §5.12). A name comes from the server
 * as it is: control characters, bidi overrides or a zero-width space can make it read as another
 * name (`report\u202Efdp.exe` reads "reportexe.pdf"). What the panel draws puts U+FFFD in place
 * of each such character, and of a space at either end, which a page never shows; the escaped
 * form is the tooltip. Every operation keeps the raw name. Framework-free.
 */

const PLACEHOLDER = '\uFFFD';
const SPACE = ' ';

/**
 * Code points a name can hold without showing them, besides control characters: Unicode's
 * default-ignorable code points (Default_Ignorable_Code_Point, Unicode 17; it holds the daemon's
 * `isInvisibleFormatChar` set), the format characters it leaves out except the visible prefixes
 * (U+0600–U+0605, U+06DD, U+070F, U+0890–U+0891, U+08E2, U+110BD, U+110CD), the line and
 * paragraph separators, which break a line like `\n`, the braille blank, a glyph with nothing
 * in it, and the space separators other than U+0020: a run of them never collapses, so it can
 * push the real end of a name out of view (`invoice.pdf` + 100 em spaces + `.exe`). Listed rather
 * than matched with `\p{…}` or `\s`, whose tables are each browser's own Unicode version;
 * reserved code points in a default-ignorable range count, as the property says, so a later
 * assignment stays hidden.
 */
const HIDDEN: ReadonlyArray<readonly [first: number, last: number]> = [
  [0x00a0, 0x00a0], // no-break space
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul choseong and jungseong fillers
  [0x1680, 0x1680], // Ogham space mark
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian free variation selectors, vowel separator
  [0x2000, 0x200a], // en quad to hair space
  [0x200b, 0x200f], // zero-width space, non-joiner and joiner, directional marks
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x202f, 0x202f], // narrow no-break space
  [0x205f, 0x205f], // medium mathematical space
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates, deprecated formats
  [0x2800, 0x2800], // braille pattern blank
  [0x3000, 0x3000], // ideographic space
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // zero-width no-break space (BOM)
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff0, 0xfffb], // reserved, interlinear annotation controls
  [0x13430, 0x1343f], // Egyptian hieroglyph format controls
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical symbol format controls
  [0xe0000, 0xe0fff], // tags, variation selectors supplement, reserved
];

function isHiddenChar(codePoint: number): boolean {
  if (codePoint < 0xa0) return isControlChar(codePoint);
  return HIDDEN.some(([first, last]) => codePoint >= first && codePoint <= last);
}

function escaped(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase();
  return codePoint > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
}

export interface ShownName {
  /** What to draw: U+FFFD for each hidden character and each space at either end. */
  text: string;
  /** The name with those characters escaped (`report\u202Efdp.exe`); null when nothing was. */
  title: string | null;
}

/** A remote name or path for display: see the module comment. */
export function displayName(raw: string): ShownName {
  const chars = Array.from(raw);
  let start = 0;
  while (start < chars.length && chars[start] === SPACE) start++;
  let end = chars.length;
  while (end > start && chars[end - 1] === SPACE) end--;
  let text = '';
  let title = '';
  let changed = false;
  for (const [index, ch] of chars.entries()) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (index < start || index >= end || isHiddenChar(codePoint)) {
      text += PLACEHOLDER;
      title += escaped(codePoint);
      changed = true;
    } else {
      text += ch;
      title += ch;
    }
  }
  return changed ? { text, title } : { text: raw, title: null };
}

/** A piece of a sentence with remote names in it: its own words, or one of the names. */
export type SentencePart = string | { name: string };

/**
 * A catalog sentence with remote names in it, split so that each name can be drawn on its own
 * (`withNames`). Catalog values are plain text: `format` gets a mark in place of each name, a
 * control character no catalog message holds, and the marks in what it returns become the
 * names, in the order the sentence has them.
 */
export function splitNames<const Names extends readonly string[]>(
  names: Names,
  format: (...marks: { [K in keyof Names]: string }) => string,
): SentencePart[] {
  const marks = names.map((_, index) => String.fromCharCode(1 + index));
  const parts: SentencePart[] = [];
  let text = '';
  for (const ch of format(...(marks as { [K in keyof Names]: string }))) {
    const name = names[ch.charCodeAt(0) - 1];
    if (name === undefined) {
      text += ch;
    } else {
      parts.push(text, { name });
      text = '';
    }
  }
  parts.push(text);
  return parts;
}
