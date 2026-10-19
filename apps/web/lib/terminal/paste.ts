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
 */
export function interceptPaste(
  element: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  terminal: PasteTarget,
): Disposable {
  const onPaste = (event: Event): void => {
    // Always ours, even without text: falling through would reach xterm's unsanitized handler.
    event.preventDefault();
    event.stopPropagation();
    const text = (event as ClipboardEvent).clipboardData?.getData('text/plain');
    if (text) pasteText(terminal, text);
  };
  element.addEventListener('paste', onPaste, true);
  return { dispose: () => element.removeEventListener('paste', onPaste, true) };
}
