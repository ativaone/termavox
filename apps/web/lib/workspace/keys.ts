/**
 * Bytes the phone extra-key bar sends (plan §11.2, D-17). Arrows follow the terminal's cursor-key
 * mode (DECCKM): `ESC [ A` normally, `ESC O A` in application mode (vim, less, htop). A sticky
 * Ctrl turns the next printable key into its control byte (`key & 0x1f`, Ctrl+C → 0x03) and
 * arrows into xterm's modified form (`ESC [ 1 ; 5 A`). A sticky Alt sends the next key with an
 * ESC prefix (what terminals send for Meta, `ESC b` for Alt+B) and arrows with modifier 3
 * (`ESC [ 1 ; 3 A`); both together give modifier 7.
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
  alt?: boolean;
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

/** Alt + any key typed on the soft keyboard: the key's bytes behind an ESC prefix. */
export function altChar(key: string): string | null {
  if (key.length === 0 || key.length > 2) return null;
  return `\x1b${key}`;
}

/** xterm's modifier parameter: 1 + (Shift 1) + (Alt 2) + (Ctrl 4). */
function modifierParam(modifiers: KeyModifiers): number {
  return 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

export function encodeKey(key: TerminalKey, modifiers: KeyModifiers = {}): string {
  const final = ARROW_FINAL[key];
  if (final) {
    if (modifiers.ctrl || modifiers.alt) return `\x1b[1;${modifierParam(modifiers)}${final}`;
    return modifiers.applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
  }
  if (key === 'Escape') return '\x1b';
  const base = key === 'Tab' ? '\t' : ((modifiers.ctrl ? ctrlChar(key) : null) ?? key);
  return modifiers.alt ? `\x1b${base}` : base;
}
