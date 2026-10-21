/**
 * Clipboard text pasted into a terminal. xterm brackets a paste as is (`ESC[200~ text ESC[201~`
 * when the program enabled bracketed paste), so clipboard text that carries its own `ESC[201~`
 * (a web page's copy handler, or an OSC 52 write the user allowed) would end the paste early and
 * the rest would run as typed input. Every paste path removes the control characters first.
 */
import type { Disposable } from './types.ts';

/** C0 controls, DEL and C1 controls (Unicode `Cc`), except TAB, LF and CR. */
const PASTE_CONTROLS = /(?![\t\n\r])\p{Cc}/gu;

/**
 * Removes ESC and every other C0 control except TAB, LF and CR, DEL and the C1 controls. All
 * other text (printable Unicode, emoji, CJK) is kept as it is.
 */
export function sanitizePaste(text: string): string {
  return text.replace(PASTE_CONTROLS, '');
}

/** What pasting needs from the xterm `Terminal`. */
export interface PasteTarget {
  paste(text: string): void;
}

/** Image types a paste can carry to the server (plan D-48), with the extension saved under. */
export const PASTE_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The first image of one of PASTE_IMAGE_TYPES the clipboard carries, or null. */
export function clipboardImage(data: Pick<DataTransfer, 'items'> | null | undefined): File | null {
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind === 'file' && Object.hasOwn(PASTE_IMAGE_TYPES, item.type)) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/** What a typed path may not carry: controls, format characters, line and paragraph separators. */
const UNPASTABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/** Characters a shell reads as themselves in a word: a path made of them needs no quotes. */
const SHELL_PLAIN = /^[A-Za-z0-9_./@%+=:,~-]+$/;

/**
 * A path from the server (plan D-48), as it may be typed into a shell: null when it holds a
 * control character, a format character (bidi controls, zero-width characters…) or a line or
 * paragraph separator, which no quoting makes safe to type. A path of plain characters only is
 * returned as is; anything else is single-quoted for POSIX shells (`'` becomes `'\''`).
 */
export function pastablePath(path: string): string | null {
  if (path.length === 0 || UNPASTABLE.test(path)) return null;
  if (SHELL_PLAIN.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Pastes through xterm (so bracketed paste is honoured), sanitized; nothing when empty. */
export function pasteText(terminal: PasteTarget, text: string): void {
  const clean = sanitizePaste(text);
  if (clean) terminal.paste(clean);
}

/**
 * Takes over native pastes (Ctrl/⌘+V, the browser's context menu, middle click) on the
 * terminal's element. xterm listens for `paste` on its textarea and on its element in the bubble
 * phase; this capture-phase listener on the element runs before both, keeps the event from
 * reaching them (and the browser from inserting the text), and pastes the sanitized text once.
 * A clipboard with an image and no text goes to `onImage` instead (plan D-48).
 */
export function interceptPaste(
  element: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  terminal: PasteTarget,
  onImage?: (image: File) => void,
): Disposable {
  const onPaste = (event: Event): void => {
    // Always ours, even without text: falling through would reach xterm's unsanitized handler.
    event.preventDefault();
    event.stopPropagation();
    const data = (event as ClipboardEvent).clipboardData;
    const text = data?.getData('text/plain');
    if (text) {
      pasteText(terminal, text);
      return;
    }
    const image = onImage ? clipboardImage(data) : null;
    if (image) onImage?.(image);
  };
  element.addEventListener('paste', onPaste, true);
  return { dispose: () => element.removeEventListener('paste', onPaste, true) };
}
