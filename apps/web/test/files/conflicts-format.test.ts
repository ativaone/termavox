import { TRANSFER_PATH } from '@termavox/protocol';
import { ErrorCode } from '@termavox/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { transferUrl } from '../../lib/files/client.ts';
import {
  findConflicts,
  numberedName,
  planUploads,
  splitName,
  uniqueName,
} from '../../lib/files/conflicts.ts';
import { ClientFileCode, FileCode, fileErrorKey } from '../../lib/files/errors.ts';
import { formatModified, formatSize, formatSpeed, percentOf } from '../../lib/files/format.ts';
import {
  PANEL_MIN_WIDTH,
  PaneFilesStore,
  panelGeometry,
  TERMINAL_MIN_WIDTH,
} from '../../lib/files/pane-state.ts';
import en from '../../messages/en.json' with { type: 'json' };
import ptBR from '../../messages/pt-BR.json' with { type: 'json' };

describe('upload name conflicts (plan §5.12)', () => {
  it('splits stems and extensions: dot-files, no extension, archives', () => {
    expect(splitName('a.txt')).toEqual({ stem: 'a', ext: '.txt' });
    expect(splitName('.env')).toEqual({ stem: '.env', ext: '' });
    expect(splitName('.config.json')).toEqual({ stem: '.config', ext: '.json' });
    expect(splitName('Makefile')).toEqual({ stem: 'Makefile', ext: '' });
    expect(splitName('odd.')).toEqual({ stem: 'odd.', ext: '' });
    expect(splitName('site.tar.gz')).toEqual({ stem: 'site', ext: '.tar.gz' });
    expect(splitName('.tar.gz')).toEqual({ stem: '.tar', ext: '.gz' });
  });

  it('numbers the first free name', () => {
    const taken = (names: string[]) => (name: string) => names.includes(name);
    expect(uniqueName('a.txt', taken(['a.txt']))).toBe('a (1).txt');
    expect(uniqueName('a.txt', taken(['a.txt', 'a (1).txt']))).toBe('a (2).txt');
    expect(uniqueName('.env', taken(['.env']))).toBe('.env (1)');
    expect(uniqueName('README', taken(['README', 'README (1)']))).toBe('README (2)');
    expect(uniqueName('site.tar.gz', taken([]))).toBe('site (1).tar.gz');
    // Never past 255 UTF-8 bytes: the stem gives way, the extension stays.
    const long = `${'é'.repeat(126)}.txt`; // 252 + 4 bytes = 256
    const numbered = numberedName(long, 1);
    expect(new TextEncoder().encode(numbered).byteLength).toBeLessThanOrEqual(255);
    expect(numbered.endsWith(' (1).txt')).toBe(true);
  });

  it('plans a batch by the choice made once for all conflicts', () => {
    const existing = new Set(['a.txt', 'a (1).txt', 'b.txt']);
    const files = ['a.txt', 'b.txt', 'c.txt'].map((name) => ({ name, size: 1, source: name }));
    expect(
      findConflicts(
        files.map((f) => f.name),
        existing,
      ),
    ).toEqual(['a.txt', 'b.txt']);

    const replace = planUploads(files, existing, 'replace');
    expect(replace.map((u) => [u.name, u.overwrite])).toEqual([
      ['a.txt', true],
      ['b.txt', true],
      ['c.txt', false],
    ]);
    const keepBoth = planUploads(files, existing, 'keepBoth');
    expect(keepBoth.map((u) => [u.source, u.name, u.overwrite])).toEqual([
      ['a.txt', 'a (2).txt', false],
      ['b.txt', 'b (1).txt', false],
      ['c.txt', 'c.txt', false],
    ]);
    const skip = planUploads(files, existing, 'skip');
    expect(skip.map((u) => u.name)).toEqual(['c.txt']);
  });

  it('keeps both when one batch carries the same name twice', () => {
    const files = [
      { name: 'x.log', size: 1, source: 1 },
      { name: 'x.log', size: 2, source: 2 },
    ];
    expect(planUploads(files, new Set(), 'replace').map((u) => [u.name, u.overwrite])).toEqual([
      ['x.log', false],
      ['x (1).log', false],
    ]);
  });
});

describe('file panel formats', () => {
  it('prints sizes in binary steps with one decimal below 10', () => {
    expect(formatSize(0, 'en')).toBe('0 B');
    expect(formatSize(412, 'en')).toBe('412 B');
    expect(formatSize(3_174, 'en')).toBe('3.1 KB');
    expect(formatSize(3_174, 'pt-BR')).toBe('3,1 KB');
    expect(formatSize(88_064, 'en')).toBe('86 KB');
    expect(formatSize(155_189_248, 'en')).toBe('148 MB');
    expect(formatSize(1_048_575, 'en')).toBe('1 MB');
    expect(formatSpeed(3_250_000, 'en')).toBe('3.1 MB/s');
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(300, 200)).toBe(100);
  });

  it('says today for today, and adds the year for other years', () => {
    const now = new Date(2026, 9, 19, 15, 0).getTime();
    expect(formatModified(new Date(2026, 9, 19, 9, 15).getTime(), now, 'en')).toMatch(/^today /);
    expect(formatModified(new Date(2026, 9, 19, 9, 15).getTime(), now, 'pt-BR')).toMatch(/^hoje /);
    expect(formatModified(new Date(2026, 9, 18, 14, 2).getTime(), now, 'en')).not.toMatch(/2026/);
    expect(formatModified(new Date(2024, 0, 5, 8, 0).getTime(), now, 'en')).toMatch(/2024/);
  });
});

describe('file panel errors', () => {
  it('mirrors the shared error codes the panel reads', () => {
    for (const [name, code] of Object.entries(FileCode)) {
      expect(ErrorCode[name as keyof typeof ErrorCode]).toBe(code);
    }
  });

  it('words every code, unknown ones generically', () => {
    expect(fileErrorKey(FileCode.SftpUnavailable)).toBe('sftpUnavailable');
    expect(fileErrorKey(FileCode.RemoveTooLarge)).toBe('removeTooLarge');
    expect(fileErrorKey(ClientFileCode.ProxyTooLarge)).toBe('proxyTooLarge');
    expect(fileErrorKey('SOMETHING_NEW')).toBe('generic');
    expect(fileErrorKey('toString')).toBe('generic');
  });

  it('has a sentence for every code in both languages', () => {
    for (const messages of [en, ptBR]) {
      const sentences: Record<string, string> = messages.files.error;
      for (const code of [...Object.values(FileCode), ...Object.values(ClientFileCode)]) {
        expect(sentences[fileErrorKey(code)], code).toBeTruthy();
      }
    }
  });

  it("words Delete's own bound as Termavox's, never the server's, pointing at the terminal", () => {
    const sentence = (messages: typeof en, locale: 'en' | 'pt-BR') =>
      createTranslator({ locale, messages, namespace: 'files.error' })(
        fileErrorKey(ErrorCode.RemoveTooLarge),
      );
    expect(sentence(en, 'en')).toBe(
      'This folder is too large for the panel to delete. Delete it from the terminal (for example with rm -r).',
    );
    expect(sentence(ptBR, 'pt-BR')).toBe(
      'Esta pasta é grande demais para apagar pelo painel. Apague-a pelo terminal (por exemplo, com rm -r).',
    );
  });
});

describe('transfer URLs', () => {
  it('resolve against the WebSocket origin and refuse anything else', () => {
    expect(transferUrl(`${TRANSFER_PATH}/upload/abc`, 'wss://term.example.com/ws')).toBe(
      'https://term.example.com/transfer/upload/abc',
    );
    expect(transferUrl('/transfer/download/x', 'ws://localhost:3001/ws')).toBe(
      'http://localhost:3001/transfer/download/x',
    );
    expect(() => transferUrl('https://evil.example/transfer/x', 'wss://a/ws')).toThrow();
    expect(() => transferUrl('/api/ws/ticket', 'wss://a/ws')).toThrow();
    expect(() => transferUrl('/transfer//evil.example/x', 'wss://a/ws')).toThrow();
  });
});

describe('file panel per pane', () => {
  it('docks between 300 px and what leaves the terminal 320 px, else covers it', () => {
    expect(panelGeometry(1200, 380)).toEqual({ mode: 'dock', width: 380, max: 872 });
    expect(panelGeometry(1200, 100).width).toBe(PANEL_MIN_WIDTH);
    expect(panelGeometry(1200, 5000).width).toBe(872);
    const narrow = PANEL_MIN_WIDTH + TERMINAL_MIN_WIDTH + 8 - 1;
    expect(panelGeometry(narrow, 380)).toMatchObject({ mode: 'cover', width: narrow });
    expect(panelGeometry(narrow + 1, 380)).toMatchObject({ mode: 'dock', width: PANEL_MIN_WIDTH });
  });

  it('remembers a pane per session, in memory, and starts over for another session', () => {
    const store = new PaneFilesStore();
    let calls = 0;
    store.subscribe(() => calls++);
    expect(store.get('p1', 's1')).toBeNull();
    store.toggle('p1', 's1');
    store.update('p1', 's1', { path: '/srv', showHidden: true });
    const state = store.get('p1', 's1');
    expect(state).toMatchObject({ open: true, path: '/srv', showHidden: true, width: 440 });
    store.update('p1', 's1', { path: '/srv' });
    expect(store.get('p1', 's1')).toBe(state); // nothing changed: same snapshot
    expect(calls).toBe(2);
    expect(store.get('p1', 's2')).toBeNull();
    store.retain(new Set(['p2']));
    expect(store.get('p1', 's1')).toBeNull();
  });
});
