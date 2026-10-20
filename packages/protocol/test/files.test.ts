import { describe, expect, it } from 'vitest';
import {
  FILES_LIMITS,
  fileNameProblem,
  parseClientMessage,
  parseServerMessage,
} from '../src/index.ts';

const roundTrip = (parse: (raw: string) => unknown, message: unknown) =>
  expect(parse(JSON.stringify(message))).toEqual(message);

describe('file panel messages (plan §5.12)', () => {
  it('round-trips the client messages, every request op included', () => {
    const requests = [
      { op: 'open' },
      { op: 'list', path: '/home/tv' },
      { op: 'mkdir', path: '/home/tv/new' },
      { op: 'rename', from: '/a', to: '/b' },
      { op: 'remove', paths: ['/a', '/b/c'] },
      { op: 'upload', dir: '/home/tv', name: 'report.pdf', size: 1024, overwrite: false },
      { op: 'download', path: '/var/log/syslog' },
    ];
    for (const request of requests) {
      roundTrip(parseClientMessage, {
        type: 'files.request',
        requestId: 'r1',
        sessionId: 's1',
        request,
      });
    }
    roundTrip(parseClientMessage, { type: 'files.cancel', requestId: 'r1' });
    roundTrip(parseClientMessage, { type: 'transfer.cancel', transferId: 't1' });
  });

  it('round-trips the server messages', () => {
    const entry = {
      name: 'link',
      type: 'link',
      target: null,
      linkTo: '/nowhere',
      size: 8,
      mtime: 1_700_000_000_000,
      mode: 0o777,
    };
    const results = [
      { op: 'open', home: '/home/tv', cwd: null },
      { op: 'open', home: '/home/tv', cwd: '/tmp' },
      { op: 'list', path: '/home/tv', entries: [entry], truncated: true },
      { op: 'mkdir', entry: { name: 'new', type: 'dir', size: 4096, mtime: 0, mode: 0o755 } },
      { op: 'rename', entry },
      { op: 'remove', removed: 12 },
      { op: 'upload', transferId: 't1', url: '/transfer/upload/abc' },
      { op: 'download', transferId: 't2', url: '/transfer/download/def', name: 'a', size: 3 },
    ];
    for (const result of results) {
      roundTrip(parseServerMessage, { type: 'files.result', requestId: 'r1', result });
    }
    roundTrip(parseServerMessage, {
      type: 'files.result',
      requestId: 'r1',
      error: { code: 'NOT_FOUND', message: 'no such file or folder' },
    });
    roundTrip(parseServerMessage, { type: 'files.progress', requestId: 'r1', removed: 40 });
    roundTrip(parseServerMessage, {
      type: 'transfer.progress',
      transferId: 't1',
      bytes: 10,
      size: 20,
      state: 'failed',
      code: 'CANCELLED',
    });
  });

  it('throws on an unknown op inside a known message instead of ignoring it', () => {
    const request = (inner: unknown) =>
      JSON.stringify({ type: 'files.request', requestId: 'r1', sessionId: 's1', request: inner });
    expect(() => parseClientMessage(request({ op: 'chmod', path: '/a', mode: 0o600 }))).toThrow();
    expect(() => parseClientMessage(request({ op: 'list', path: 'relative' }))).toThrow();
    expect(() => parseClientMessage(request({ op: 'remove', paths: [] }))).toThrow();
    const tooMany = Array.from({ length: FILES_LIMITS.removePaths + 1 }, (_, i) => `/f${i}`);
    expect(() => parseClientMessage(request({ op: 'remove', paths: tooMany }))).toThrow();
    expect(() =>
      parseServerMessage(
        JSON.stringify({ type: 'files.result', requestId: 'r1', result: { op: 'chmod' } }),
      ),
    ).toThrow();
    // A message type this side does not know is still ignored.
    expect(parseClientMessage('{"type":"files.future","x":1}')).toBeNull();
  });

  it('names what makes a file name unusable', () => {
    expect(fileNameProblem('report.pdf')).toBeNull();
    expect(fileNameProblem('')).toBe('empty');
    expect(fileNameProblem('..')).toBe('dot');
    expect(fileNameProblem('a/b')).toBe('slash');
    expect(fileNameProblem('a\0b')).toBe('nul');
    expect(fileNameProblem('é'.repeat(128))).toBe('too_long');
  });
});
