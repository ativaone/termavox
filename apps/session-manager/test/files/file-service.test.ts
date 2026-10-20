import type { FileRequest, ServerMessage } from '@termavox/protocol';
import { ErrorCode, TermavoxError } from '@termavox/shared';
import { describe, expect, it } from 'vitest';
import { type FileHost, SftpError, SftpStatus } from '../../src/core/types.ts';
import {
  AUDIT_REMOVE_PATHS,
  FileService,
  PROGRESS_INTERVAL_MS,
} from '../../src/files/file-service.ts';
import type { FileSettings } from '../../src/files/settings.ts';
import type { AuditInput } from '../../src/store/audit.ts';
import type { FileRequestContext } from '../../src/ws/types.ts';
import { until } from '../runtime/fakes.ts';
import { HOME, MemorySftp } from './memory-sftp.ts';

class FakeFileHost implements FileHost {
  readonly sessionId: string;
  readonly userId: string;
  readonly serverId = 'server-1';
  readonly fs = new MemorySftp();
  ready = true;
  cwd: string | null = null;
  opens = 0;
  closes = 0;

  constructor(sessionId = 'session-1', userId = 'user-1') {
    this.sessionId = sessionId;
    this.userId = userId;
  }

  async sftp(): Promise<MemorySftp> {
    if (!this.ready) {
      throw new TermavoxError(ErrorCode.SessionNotConnected, 'the session is not connected');
    }
    this.opens++;
    return this.fs;
  }

  closeSftp(): void {
    this.closes++;
  }

  async currentDirectory(): Promise<string | null> {
    return this.cwd;
  }
}

interface Setup {
  host: FakeFileHost;
  service: FileService;
  settings: FileSettings;
  audits: AuditInput[];
  sent: ServerMessage[];
  clock: { now: number };
  run(request: FileRequest, overrides?: Partial<FileRequestContext>): Promise<unknown>;
  code(request: FileRequest, overrides?: Partial<FileRequestContext>): Promise<string>;
}

function setup(options: { idleCloseMs?: number; tick?: number } = {}): Setup {
  const host = new FakeFileHost();
  host.fs.addDir('/data').addFile('/data/a.txt').addDir('/data/sub').addFile('/data/sub/b');
  const settings: FileSettings = { transferEnabled: true, auditEnabled: false };
  const audits: AuditInput[] = [];
  const sent: ServerMessage[] = [];
  const clock = { now: 1_000_000 };
  const service = new FileService({
    sessions: { fileHost: (id) => (id === host.sessionId ? host : undefined) },
    settings: () => settings,
    audit: (input) => audits.push(input),
    now: () => {
      clock.now += options.tick ?? 0;
      return clock.now;
    },
    ...(options.idleCloseMs !== undefined ? { idleCloseMs: options.idleCloseMs } : {}),
  });
  const context = (overrides: Partial<FileRequestContext> = {}): FileRequestContext => ({
    requestId: 'r1',
    userId: 'user-1',
    authSessionId: 'asid-1',
    sessionId: 'session-1',
    client: { ip: '203.0.113.7', userAgent: 'test-agent/1.0' },
    signal: new AbortController().signal,
    send: (message) => sent.push(message),
    ...overrides,
  });
  const run = (request: FileRequest, overrides?: Partial<FileRequestContext>) =>
    service.handle(context(overrides), request);
  return {
    host,
    service,
    settings,
    audits,
    sent,
    clock,
    run,
    code: (request, overrides) =>
      run(request, overrides).then(
        () => 'resolved',
        (err: unknown) => (err as TermavoxError).code,
      ),
  };
}

describe('file service gating', () => {
  it('answers FILES_DISABLED while file transfer is off, before touching the session', async () => {
    const s = setup();
    s.settings.transferEnabled = false;
    expect(await s.code({ op: 'open' })).toBe(ErrorCode.FilesDisabled);
    expect(await s.code({ op: 'mkdir', path: '/data/x' })).toBe(ErrorCode.FilesDisabled);
    expect(s.host.opens).toBe(0);
    s.settings.transferEnabled = true;
    expect(await s.code({ op: 'open' })).toBe('resolved');
  });

  it('answers SESSION_NOT_CONNECTED without a live runtime or while not ready', async () => {
    const s = setup();
    expect(await s.code({ op: 'open' }, { sessionId: 'other' })).toBe(
      ErrorCode.SessionNotConnected,
    );
    s.host.ready = false;
    expect(await s.code({ op: 'list', path: '/data' })).toBe(ErrorCode.SessionNotConnected);
  });

  it("refuses a runtime that is not the requester's (FORBIDDEN)", async () => {
    const s = setup();
    expect(await s.code({ op: 'open' }, { userId: 'user-2' })).toBe(ErrorCode.Forbidden);
  });

  it('checks names before anything reaches the server (NAME_INVALID)', async () => {
    const s = setup();
    const invalid: FileRequest[] = [
      { op: 'mkdir', path: '/data/..' },
      { op: 'mkdir', path: '/data/sub/' },
      { op: 'rename', from: '/data/a.txt', to: `/data/${'x'.repeat(256)}` },
      { op: 'rename', from: '/', to: '/data/root' },
      { op: 'remove', paths: ['/data/a.txt', '/'] },
      { op: 'upload', dir: '/data', name: 'a/b', size: 1, overwrite: false },
      { op: 'download', path: '/' },
    ];
    for (const request of invalid) {
      expect(await s.code(request), JSON.stringify(request)).toBe(ErrorCode.NameInvalid);
    }
    expect(s.host.opens).toBe(0);
    expect(s.host.fs.ops).toEqual([]);
  });

  it('answers a cancelled request CANCELLED without running it', async () => {
    const s = setup();
    const abort = new AbortController();
    abort.abort();
    expect(await s.code({ op: 'open' }, { signal: abort.signal })).toBe(ErrorCode.Cancelled);
    expect(s.host.opens).toBe(0);
  });
});

describe('file service operations', () => {
  it("opens at the user's home with the terminal's folder", async () => {
    const s = setup();
    expect(await s.run({ op: 'open' })).toEqual({ op: 'open', home: HOME, cwd: null });
    s.host.cwd = '/data/sub';
    expect(await s.run({ op: 'open' })).toEqual({ op: 'open', home: HOME, cwd: '/data/sub' });
  });

  it('lists, creates, renames and removes, with SFTP statuses mapped', async () => {
    const s = setup();
    expect(await s.run({ op: 'list', path: '/data/./' })).toMatchObject({
      op: 'list',
      path: '/data',
      truncated: false,
    });
    expect(await s.run({ op: 'mkdir', path: '/data/new' })).toMatchObject({
      op: 'mkdir',
      entry: { name: 'new', type: 'dir' },
    });
    expect(await s.code({ op: 'mkdir', path: '/data/new' })).toBe(ErrorCode.Conflict);
    expect(await s.run({ op: 'rename', from: '/data/a.txt', to: '/data/new/a.txt' })).toMatchObject(
      { op: 'rename', entry: { name: 'a.txt', type: 'file' } },
    );
    expect(await s.code({ op: 'list', path: '/missing' })).toBe(ErrorCode.NotFound);
    s.host.fs.delay = (op) => {
      if (op === 'rmdir') throw new SftpError(SftpStatus.PermissionDenied, 'Permission denied');
    };
    expect(await s.code({ op: 'remove', paths: ['/data/sub'] })).toBe(ErrorCode.PermissionDenied);
    s.host.fs.delay = null;
    expect(await s.run({ op: 'remove', paths: ['/data/new'] })).toEqual({
      op: 'remove',
      removed: 2,
    });
  });

  it('mints an upload URL once the folder and the name were checked', async () => {
    const s = setup();
    s.host.fs.addLink('/data/to-sub', '/data/sub').addLink('/data/dangling', '/nowhere');
    const upload = (dir: string, name: string, overwrite = false): FileRequest => ({
      op: 'upload',
      dir,
      name,
      size: 3,
      overwrite,
    });
    const minted = (await s.run(upload('/data/./', 'new.txt'))) as {
      op: string;
      transferId: string;
      url: string;
    };
    expect(minted.op).toBe('upload');
    expect(minted.url).toMatch(/^\/transfer\/upload\/[A-Za-z0-9_-]{43}$/);
    const grant = s.service.transfers.consume(minted.url.split('/').at(-1)!, 'upload');
    expect(grant).toMatchObject({
      transferId: minted.transferId,
      direction: 'upload',
      userId: 'user-1',
      authSessionId: 'asid-1',
      sessionId: 'session-1',
      dir: '/data',
      name: 'new.txt',
      path: '/data/new.txt',
      overwrite: false,
      size: 3,
    });
    // A folder through a link is a folder; a file is not.
    expect(await s.code(upload('/data/to-sub', 'x'))).toBe('resolved');
    expect(await s.code(upload('/data/a.txt', 'x'))).toBe(ErrorCode.NotFound);
    expect(await s.code(upload('/missing', 'x'))).toBe(ErrorCode.NotFound);
    // An existing name: CONFLICT unless replacing a file; a folder (or a link to one) never.
    expect(await s.code(upload('/data', 'a.txt'))).toBe(ErrorCode.Conflict);
    expect(await s.code(upload('/data', 'a.txt', true))).toBe('resolved');
    expect(await s.code(upload('/data', 'dangling', true))).toBe('resolved');
    expect(await s.code(upload('/data', 'sub', true))).toBe(ErrorCode.Conflict);
    expect(await s.code(upload('/data', 'to-sub', true))).toBe(ErrorCode.Conflict);
  });

  it('mints a download URL for a file (links followed), with its name and size', async () => {
    const s = setup();
    s.host.fs.addFile('/data/report.pdf', 1234).addLink('/data/latest', 'report.pdf');
    const minted = await s.run({ op: 'download', path: '/data/latest' });
    expect(minted).toMatchObject({ op: 'download', name: 'latest', size: 1234 });
    const url = (minted as { url: string }).url;
    expect(url).toMatch(/^\/transfer\/download\/[A-Za-z0-9_-]{43}$/);
    expect(s.service.transfers.consume(url.split('/').at(-1)!, 'download')).toMatchObject({
      direction: 'download',
      path: '/data/latest',
      size: 1234,
    });
    expect(await s.code({ op: 'download', path: '/data/sub' })).toBe(ErrorCode.NotFound);
    expect(await s.code({ op: 'download', path: '/data/none' })).toBe(ErrorCode.NotFound);
  });

  it('voids an unused URL on transfer.cancel, for its own user only', async () => {
    const s = setup();
    const minted = (await s.run({ op: 'download', path: '/data/a.txt' })) as {
      transferId: string;
      url: string;
    };
    s.service.cancelTransfer('user-2', minted.transferId);
    expect(s.service.transfers.tokens.size).toBe(1);
    s.service.cancelTransfer('user-1', minted.transferId);
    expect(s.service.transfers.tokens.size).toBe(0);
    expect(s.service.transfers.consume(minted.url.split('/').at(-1)!, 'download')).toBeNull();
  });

  it('sends removal progress at most four times a second', async () => {
    // Every clock read advances 60 ms: a progress may go out every fifth removal at most.
    const s = setup({ tick: 60 });
    for (let i = 0; i < 40; i++) s.host.fs.addFile(`/data/sub/f${i}`);
    const times: number[] = [];
    const removed = await s.run(
      { op: 'remove', paths: ['/data/sub'] },
      {
        requestId: 'rm-1',
        send: (message) => {
          s.sent.push(message);
          times.push(s.clock.now);
        },
      },
    );
    expect(removed).toEqual({ op: 'remove', removed: 42 });
    const progress = s.sent.filter((m) => m.type === 'files.progress');
    expect(progress.length).toBeGreaterThan(3);
    expect(progress.every((m) => m.type === 'files.progress' && m.requestId === 'rm-1')).toBe(true);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(PROGRESS_INTERVAL_MS);
    }
  });
});

describe('file service audit', () => {
  it('writes nothing while the audit is off', async () => {
    const s = setup();
    await s.run({ op: 'mkdir', path: '/data/new' });
    await s.run({ op: 'rename', from: '/data/new', to: '/data/renamed' });
    await s.run({ op: 'remove', paths: ['/data/renamed'] });
    expect(s.audits).toEqual([]);
  });

  it('writes one row per change with the exact detail shapes and the client', async () => {
    const s = setup();
    s.settings.auditEnabled = true;
    const at = s.clock.now;
    const row = (type: string, detail: Record<string, unknown>) => ({
      type,
      actorUserId: 'user-1',
      targetType: 'session',
      targetId: 'session-1',
      detail: { serverId: 'server-1', ...detail },
      ip: '203.0.113.7',
      userAgent: 'test-agent/1.0',
      at,
    });
    await s.run({ op: 'open' });
    await s.run({ op: 'list', path: '/data' });
    await s.run({ op: 'mkdir', path: '/data//new' });
    await s.run({ op: 'rename', from: '/data/new', to: '/data/renamed' });
    // A refused change writes nothing.
    await s.code({ op: 'mkdir', path: '/data/renamed' });
    const many = Array.from({ length: 25 }, (_, i) => `/data/renamed/f${i}`);
    for (const path of many) s.host.fs.addFile(path);
    await s.run({ op: 'remove', paths: many });
    expect(s.audits).toEqual([
      row('file.mkdir', { path: '/data/new' }),
      row('file.rename', { from: '/data/new', to: '/data/renamed' }),
      row('file.remove', { paths: many.slice(0, AUDIT_REMOVE_PATHS), removed: 25 }),
    ]);
  });

  it('records what a cancelled removal removed', async () => {
    const s = setup();
    s.settings.auditEnabled = true;
    for (let i = 0; i < 30; i++) s.host.fs.addFile(`/data/sub/f${i}`);
    s.host.fs.delay = () => new Promise((resolve) => setTimeout(resolve, 1));
    const abort = new AbortController();
    const result = s.run(
      { op: 'remove', paths: ['/data/sub'] },
      {
        signal: abort.signal,
        send: () => {},
      },
    );
    await until(() => s.host.fs.under('/data/sub').length < 25);
    abort.abort();
    const err = await result.catch((e: unknown) => e as TermavoxError);
    expect((err as TermavoxError).code).toBe(ErrorCode.Cancelled);
    const removed = 31 - s.host.fs.under('/data/sub').length;
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]!.detail).toEqual({ serverId: 'server-1', paths: ['/data/sub'], removed });
  });
});

describe('the idle close of a session channel', () => {
  it('closes the channel once nothing used it for the idle time', async () => {
    const s = setup({ idleCloseMs: 40 });
    await s.run({ op: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await s.run({ op: 'list', path: '/data' }); // restarts the wait
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(s.host.closes).toBe(0);
    await until(() => s.host.closes === 1, 1_000);

    // A use held open (part 2: a transfer) keeps it from closing until released.
    const release = s.service.holdChannel(s.host);
    await s.run({ op: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(s.host.closes).toBe(1);
    release();
    release(); // idempotent
    await until(() => s.host.closes === 2, 1_000);
    s.service.close();
  });
});
