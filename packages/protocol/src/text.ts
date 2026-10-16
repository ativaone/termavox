/**
 * Remote text the UI renders (terminal titles, keyboard-interactive prompts) is cleaned by the
 * daemon before it is sent and again by the web client before it is shown; both sides share
 * this character set.
 */

/**
 * Invisible formatting characters that make text read differently from what it is: zero-width
 * and directional marks (U+200B–U+200F), bidi embeddings and overrides (U+202A–U+202E), bidi
 * isolates (U+2066–U+2069) and the zero-width no-break space / BOM (U+FEFF).
 */
export function isInvisibleFormatChar(codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/** C0 controls, DEL and C1 controls. */
export function isControlChar(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}
