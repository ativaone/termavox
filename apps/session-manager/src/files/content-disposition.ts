import { isControlChar } from '@termavox/protocol';

/**
 * Invisible characters a name loses in the header: Unicode's default-ignorable code points, which
 * render as nothing, and the interlinear annotation marks (U+FFF9–U+FFFB). They include the
 * daemon's invisible formatting set (bidi embeddings, overrides and isolates, zero-width
 * characters, the BOM: `isInvisibleFormatChar`), and also the word joiner, soft hyphen, Arabic
 * letter mark, Hangul fillers and variation selectors.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\uFFF9-\uFFFB]/u;
/** The line and paragraph separators: they break a line like `\n`, so they go as controls do. */
const SEPARATOR = /[\u2028\u2029]/u;
/** What a name that has nothing visible left is sent as. */
const PLACEHOLDER = '_';

/**
 * `Content-Disposition` of a download (plan §5.12): always an attachment, never shown inline, with
 * the file name twice: an ASCII fallback (RFC 6266 quoted-string) for old clients and the name in
 * UTF-8 (RFC 5987 `filename*`), which every current browser prefers. Neither carries invisible
 * characters, and `filename*` no controls or line separators either: the saved name reads as what
 * it is (a planted `report<U+202E>fdp.exe` would show as `reportexe.pdf`).
 */
export function contentDisposition(name: string): string {
  const visible = withoutChars(name.toWellFormed(), (ch) => INVISIBLE.test(ch));
  const exact = withoutChars(
    visible,
    (ch) => isControlChar(ch.codePointAt(0)!) || SEPARATOR.test(ch),
  );
  return `attachment; filename="${asciiFallback(visible || PLACEHOLDER)}"; filename*=UTF-8''${encodeExtValue(exact || PLACEHOLDER)}`;
}

function withoutChars(name: string, drop: (ch: string) => boolean): string {
  let out = '';
  for (const ch of name) if (!drop(ch)) out += ch;
  return out;
}

/** Non-ASCII and control characters become `_`; `"` and `\` are escaped. */
function asciiFallback(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code >= 0x7f) out += '_';
    else if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/** RFC 5987 `value-chars`: encodeURIComponent leaves `!'()*` alone, which `attr-char` excludes. */
function encodeExtValue(name: string): string {
  return encodeURIComponent(name).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
