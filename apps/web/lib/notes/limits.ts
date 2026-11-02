import { isControlChar, isInvisibleFormatChar } from '@termavox/protocol/client';

/** Longest note title, in code points. */
export const NOTE_TITLE_MAX = 80;
/** Largest note body, in UTF-8 bytes. */
export const NOTE_BODY_MAX_BYTES = 256 * 1024;
export const NOTES_PER_SESSION_MAX = 50;

const encoder = new TextEncoder();

/**
 * A note title as stored, like a session label: control characters and invisible formatting
 * dropped, then trimmed. Null when nothing is left or it is over NOTE_TITLE_MAX.
 */
export function cleanNoteTitle(raw: string): string | null {
  let kept = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (!isControlChar(code) && !isInvisibleFormatChar(code)) kept += ch;
  }
  const title = kept.trim();
  if (title.length === 0 || [...title].length > NOTE_TITLE_MAX) return null;
  return title;
}

/** The UTF-8 size of a note body. */
export function noteBodyBytes(text: string): number {
  return encoder.encode(text).length;
}
