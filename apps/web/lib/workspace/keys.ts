/**
 * Bytes the phone extra-key bar sends (plan §11.2). Arrows follow the terminal's cursor-key mode
 * (DECCKM): `ESC [ A` normally, `ESC O A` in application mode (vim, less, htop). A sticky Ctrl
 * turns the next printable key into its control byte (`key & 0x1f`, Ctrl+C → 0x03) and arrows
 * into xterm's modified form (`ESC [ 1 ; 5 A`).
 */

export type TerminalKey =
  | 'Escape'
  | 'Tab'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | '|';

export interface KeyModifiers {
  ctrl?: boolean;
  /** `terminal.modes.applicationCursorKeysMode`. */
  applicationCursor?: boolean;
}

const ARROW_FINAL: Partial<Record<TerminalKey, string>> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
};

/** Ctrl + a printable ASCII key: its control byte, or null when the key has no control form. */
export function ctrlChar(key: string): string | null {
  if (key.length !== 1) return null;
  const code = key.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) return null;
  return String.fromCharCode(code & 0x1f);
}

export function encodeKey(key: TerminalKey, modifiers: KeyModifiers = {}): string {
  const final = ARROW_FINAL[key];
  if (final) {
    if (modifiers.ctrl) return `\x1b[1;5${final}`;
    return modifiers.applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
  }
  if (key === 'Escape') return '\x1b';
  if (key === 'Tab') return '\t';
  return (modifiers.ctrl ? ctrlChar(key) : null) ?? key;
}
