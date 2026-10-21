import { describe, expect, it, vi } from 'vitest';
import {
  clipboardImage,
  interceptPaste,
  PASTE_IMAGE_TYPES,
  pastablePath,
  pasteText,
  sanitizePaste,
} from '../../lib/terminal/paste.ts';

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

interface FakeItem {
  kind: string;
  type: string;
  getAsFile: () => File | null;
}

const fileItem = (type: string, file: File | null = new File(['x'], 'image', { type })) => ({
  kind: 'file',
  type,
  getAsFile: vi.fn(() => file),
});

/** A DataTransferItemList as the browser hands it: array-like, not an Array. */
function itemList(...items: FakeItem[]): DataTransferItemList {
  const list: Record<number, FakeItem> & { length: number } = { length: items.length };
  items.forEach((item, index) => {
    list[index] = item;
  });
  return list as unknown as DataTransferItemList;
}

/** A paste event whose clipboard holds `text` (as getData returns it) and `items`. */
function imagePasteEvent(text: string, ...items: FakeItem[]) {
  return {
    clipboardData: { getData: vi.fn(() => text), items: itemList(...items) },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function intercept(onImage?: (image: File) => void) {
  const element = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const terminal = { paste: vi.fn() };
  interceptPaste(element, terminal, onImage);
  const listener = element.addEventListener.mock.calls[0]![1] as (event: Event) => void;
  return { terminal, paste: (event: unknown) => listener(event as Event) };
}

describe('image paste (plan D-48)', () => {
  it('accepts PNG, JPEG, GIF and WebP, each with the extension it is saved under', () => {
    expect(PASTE_IMAGE_TYPES).toEqual({
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
    });
  });

  it('pastes the text when the clipboard has text and an image; the image is never read', () => {
    const onImage = vi.fn();
    const { terminal, paste } = intercept(onImage);
    const png = fileItem('image/png');
    const event = imagePasteEvent('ls -la\r', png);
    paste(event);
    expect(terminal.paste).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith('ls -la\r');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();

    // Text wins even when sanitizing leaves nothing of it.
    paste(imagePasteEvent('\x1b', png));
    expect(terminal.paste).toHaveBeenCalledOnce();
    expect(png.getAsFile).not.toHaveBeenCalled();
    expect(onImage).not.toHaveBeenCalled();
  });

  it('hands an image-only paste to onImage once, and still takes the event', () => {
    const onImage = vi.fn();
    const { terminal, paste } = intercept(onImage);
    const file = new File(['png bytes'], 'image.png', { type: 'image/png' });
    const event = imagePasteEvent('', fileItem('image/png', file));
    paste(event);
    expect(onImage).toHaveBeenCalledOnce();
    expect(onImage.mock.calls[0]![0]).toBe(file);
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('ignores image types it does not accept and items that are not files', () => {
    const onImage = vi.fn();
    const { terminal, paste } = intercept(onImage);
    const ignored = [
      fileItem('image/svg+xml'),
      fileItem('image/bmp'),
      fileItem('image/tiff'),
      // Keys of Object.prototype are not accepted types.
      fileItem('toString'),
      fileItem('constructor'),
      { kind: 'string', type: 'image/png', getAsFile: vi.fn(() => null) },
      { kind: 'string', type: 'text/html', getAsFile: vi.fn(() => null) },
    ];
    const event = imagePasteEvent('', ...ignored);
    paste(event);
    expect(onImage).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
    for (const item of ignored) expect(item.getAsFile).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('without onImage, an image-only paste pastes nothing and the event is still taken', () => {
    const { terminal, paste } = intercept();
    const png = fileItem('image/png');
    const event = imagePasteEvent('', png);
    paste(event);
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(png.getAsFile).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('clipboardImage: null without data or items; the first accepted image otherwise', () => {
    expect(clipboardImage(null)).toBeNull();
    expect(clipboardImage(undefined)).toBeNull();
    expect(clipboardImage({} as Pick<DataTransfer, 'items'>)).toBeNull();
    expect(clipboardImage({ items: itemList() })).toBeNull();
    expect(clipboardImage({ items: itemList(fileItem('image/svg+xml')) })).toBeNull();

    const jpeg = new File(['jpeg bytes'], 'photo.jpg', { type: 'image/jpeg' });
    const later = fileItem('image/png');
    const items = itemList(
      { kind: 'string', type: 'text/html', getAsFile: vi.fn(() => null) },
      fileItem('image/svg+xml'),
      fileItem('image/jpeg', jpeg),
      later,
    );
    expect(clipboardImage({ items })).toBe(jpeg);
    expect(later.getAsFile).not.toHaveBeenCalled();

    for (const type of Object.keys(PASTE_IMAGE_TYPES)) {
      const file = new File(['x'], 'image', { type });
      expect(clipboardImage({ items: itemList(fileItem(type, file)) })).toBe(file);
    }
  });

  it('clipboardImage: an accepted item that yields no file gives way to the next one', () => {
    const png = new File(['png bytes'], 'shot.png', { type: 'image/png' });
    const empty = { kind: 'file', type: 'image/jpeg', getAsFile: vi.fn(() => null) };
    expect(clipboardImage({ items: itemList(empty, fileItem('image/png', png)) })).toBe(png);
    expect(empty.getAsFile).toHaveBeenCalledOnce();
    expect(clipboardImage({ items: itemList(empty) })).toBeNull();
  });
});

describe('a pasted image path, typed into the terminal (plan D-48)', () => {
  it('types a path of plain characters as it is', () => {
    const usual = '/home/tv/.cache/termavox/paste/paste-20261021-040506-a1b2.png';
    expect(pastablePath(usual)).toBe(usual);
    expect(pastablePath('/a/b@c%d+e=f:g,h~i-j_k.l/0-9/A-Z')).toBe(
      '/a/b@c%d+e=f:g,h~i-j_k.l/0-9/A-Z',
    );
  });

  it('single-quotes a path with any other character, a quote becoming a closed quote', () => {
    expect(pastablePath('/home/my user/x.png')).toBe("'/home/my user/x.png'");
    expect(pastablePath("/home/o'neil/x.png")).toBe("'/home/o'\\''neil/x.png'");
    expect(pastablePath("/a/''")).toBe("'/a/'\\'''\\'''");
    for (const ch of ['$', '`', '"', '\\', '*', '?', ';', '&', '|', '<', '>', '(', ')', '{', '}']) {
      expect(pastablePath(`/a/b${ch}c`), ch).toBe(`'/a/b${ch}c'`);
    }
    for (const ch of ['[', ']', '!', '#', ' ', 'é', '漢', '🙂', '\u00a0']) {
      expect(pastablePath(`/a/b${ch}c`), ch).toBe(`'/a/b${ch}c'`);
    }
  });

  it('refuses a path with a control, format or separator character, wherever it is', () => {
    const refused = [
      '\n',
      '\r',
      '\t',
      '\x00',
      '\x1b',
      '\x7f',
      '\u0085',
      '\u009b',
      '\u00ad',
      '\u200b',
      '\u200e',
      '\u202e',
      '\u2066',
      '\ufeff',
      '\u{e0041}',
      '\u2028',
      '\u2029',
    ];
    for (const ch of refused) {
      expect(pastablePath(`/home/tv/a${ch}b.png`), JSON.stringify(ch)).toBeNull();
      expect(pastablePath(`${ch}/home/tv/b.png`), JSON.stringify(ch)).toBeNull();
    }
    expect(pastablePath('')).toBeNull();
  });
});
