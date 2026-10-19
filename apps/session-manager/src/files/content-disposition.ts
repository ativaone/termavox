/**
 * `Content-Disposition` of a download (plan §5.12): always an attachment, never shown inline, with
 * the file name twice: an ASCII fallback (RFC 6266 quoted-string) for old clients and the exact name
 * in UTF-8 (RFC 5987 `filename*`), which every current browser prefers.
 */
export function contentDisposition(name: string): string {
  const wellFormed = name.toWellFormed();
  return `attachment; filename="${asciiFallback(wellFormed)}"; filename*=UTF-8''${encodeExtValue(wellFormed)}`;
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
