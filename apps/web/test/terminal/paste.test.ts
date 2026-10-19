import { describe, expect, it, vi } from 'vitest';
import { interceptPaste, pasteText, sanitizePaste } from '../../lib/terminal/paste.ts';

describe('paste sanitizing', () => {
  it('removes ESC, so clipboard text cannot end a bracketed paste early', () => {
    const clean = sanitizePaste('a\x1b[201~b\x1b[200~c');
    expect(clean).not.toContain('\x1b');
    // The printable remnants of the brackets stay, in order.
    expect(clean).toBe('a[201~b[200~c');
  });

  it('keeps TAB, LF and CR; removes the other C0 controls, DEL and the C1 controls', () => {
    expect(sanitizePaste('a\tb\nc\r\nd')).toBe('a\tb\nc\r\nd');
    expect(sanitizePaste('x\u0085y\u009bz\x7f')).toBe('xyz');
    expect(sanitizePaste('\x00\x03\x07\x08\x0b\x0c\x0e\x1a\x1f\x80\x9f')).toBe('');
  });

  it('keeps printable Unicode as it is', () => {
    expect(sanitizePaste('é 漢字 🙂')).toBe('é 漢字 🙂');
    expect(sanitizePaste(' nbsp ¬ ÿ')).toBe(' nbsp ¬ ÿ');
  });
});

describe('paste paths', () => {
  it('pastes through the terminal once, sanitized; nothing when only controls remain', () => {
    const terminal = { paste: vi.fn() };
    pasteText(terminal, 'ls\x1b[201~\rdate\r');
    expect(terminal.paste).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith('ls[201~\rdate\r');
    pasteText(terminal, '\x1b\x9b');
    pasteText(terminal, '');
    expect(terminal.paste).toHaveBeenCalledOnce();
  });

  it("takes native paste events over in the capture phase, before xterm's own listeners", () => {
    const element = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const terminal = { paste: vi.fn() };
    const guard = interceptPaste(element, terminal);
    expect(element.addEventListener).toHaveBeenCalledWith('paste', expect.any(Function), true);
    const listener = element.addEventListener.mock.calls[0]![1] as (event: Event) => void;
    const pasteEvent = (data: string | null) => ({
      clipboardData: data === null ? null : { getData: vi.fn(() => data) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    const event = pasteEvent('ls\x1b[201~\rdate\r');
    listener(event as unknown as Event);
    expect(event.clipboardData?.getData).toHaveBeenCalledWith('text/plain');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith('ls[201~\rdate\r');

    // Without text the event is still taken: xterm's handler would paste the raw clipboard.
    for (const data of [null, '', '\x1b']) {
      const other = pasteEvent(data);
      listener(other as unknown as Event);
      expect(other.preventDefault).toHaveBeenCalledOnce();
      expect(other.stopPropagation).toHaveBeenCalledOnce();
    }
    expect(terminal.paste).toHaveBeenCalledOnce();

    guard.dispose();
    expect(element.removeEventListener).toHaveBeenCalledWith('paste', listener, true);
  });
});
