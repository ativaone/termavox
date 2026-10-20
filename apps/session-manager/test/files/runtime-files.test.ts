import { ErrorCode, type TermavoxError } from '@termavox/shared';
import { describe, expect, it } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import type { SftpSession } from '../../src/core/types.ts';
import { harness, TMUX_PROBE, until } from '../runtime/fakes.ts';
import { MemorySftp } from './memory-sftp.ts';

const codeOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (err: unknown) => (err as TermavoxError).code,
  );

/** A tmux-control driver that only answers `currentDirectory()`. */
function cwdDrivers(answer: () => Promise<string | null>) {
  return createDriverFactory(() => ({
    protection: 'tmux-control',
    start: async () => {},
    input() {},
    resize() {},
    pauseOutput() {},
    resumeOutput() {},
    detach: async () => {},
    terminate: async () => {},
    currentDirectory: answer,
  }));
}

describe('the runtime as file host (plan §5.12)', () => {
  it('opens one SFTP channel per connection, shared, and only while ready', async () => {
    const sessions: MemorySftp[] = [];
    const h = harness({
      behavior: () => ({
        sftp: async () => {
          const session = new MemorySftp();
          sessions.push(session);
          return session;
        },
      }),
    });
    const rt = h.runtime();
    expect(await codeOf(rt.sftp())).toBe(ErrorCode.SessionNotConnected);
    await rt.start();
    expect(rt.state).toBe('ready');
    expect(rt.serverId).toBe('server-1');
    const [a, b] = await Promise.all([rt.sftp(), rt.sftp()]);
    expect(a).toBe(b);
    expect(await rt.sftp()).toBe(a);
    expect(h.factory.last.sftpOpens).toBe(1);

    // Closed by the server: the next use opens another channel on the same connection.
    a.end();
    await Promise.resolve();
    const c = await rt.sftp();
    expect(c).not.toBe(a);
    expect(h.factory.last.sftpOpens).toBe(2);

    // The connection is lost: its channel is dropped with it; the next connection opens its own.
    h.factory.last.lose();
    await until(() => rt.state === 'reconnecting');
    expect(c.closed).toBe(true);
    expect(await codeOf(rt.sftp())).toBe(ErrorCode.SessionNotConnected);
    await rt.retry();
    await until(() => rt.state === 'ready');
    const d = await rt.sftp();
    expect(d).not.toBe(c);
    expect(h.factory.last.sftpOpens).toBe(1);

    // closeSftp (the file service's idle close) ends it; the next request reopens.
    rt.closeSftp();
    expect(d.closed).toBe(true);
    expect(await rt.sftp()).not.toBe(d);
    await rt.terminate();
    expect(sessions.every((s) => s.closed)).toBe(true);
    expect(await codeOf(rt.sftp())).toBe(ErrorCode.SessionNotConnected);
  });

  it('keeps no failed open, and has no file access without a transport adapter', async () => {
    let fail = true;
    const h = harness({
      behavior: () => ({
        sftp: async () => {
          if (fail) throw Object.assign(new Error('refused'), { code: ErrorCode.SftpUnavailable });
          return new MemorySftp();
        },
      }),
    });
    const rt = h.runtime();
    await rt.start();
    await expect(rt.sftp()).rejects.toThrow('refused');
    fail = false;
    await expect(rt.sftp()).resolves.toBeInstanceOf(MemorySftp);
    expect(h.factory.last.sftpOpens).toBe(2);
    await rt.terminate();

    const none = harness().runtime();
    await none.start();
    expect(await codeOf(none.sftp())).toBe(ErrorCode.SftpUnavailable);
    await none.terminate();
  });

  it('ends a channel that finished opening after its connection was torn down', async () => {
    const opening = Promise.withResolvers<SftpSession>();
    const h = harness({ behavior: () => ({ sftp: () => opening.promise }) });
    const rt = h.runtime();
    await rt.start();
    const pending = codeOf(rt.sftp());
    await rt.terminate();
    const late = new MemorySftp();
    opening.resolve(late);
    expect(await pending).toBe(ErrorCode.SessionNotConnected);
    expect(late.closed).toBe(true);
  });

  it("reports the terminal's folder only as an absolute single-line path", async () => {
    let answer: string | null = '/tmp';
    const h = harness({
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: cwdDrivers(async () => answer),
    });
    const rt = h.runtime();
    expect(await rt.currentDirectory()).toBeNull(); // not ready
    await rt.start();
    expect(rt.protection).toBe('tmux-control');
    expect(await rt.currentDirectory()).toBe('/tmp');
    for (const bad of ['relative/path', '/two\nlines', '/nul\0', '', null]) {
      answer = bad;
      expect(await rt.currentDirectory()).toBeNull();
    }
    await rt.terminate();

    // A driver that cannot tell (raw mode) and one that fails both give null.
    const raw = harness().runtime();
    await raw.start();
    expect(raw.protection).toBe('none');
    expect(await raw.currentDirectory()).toBeNull();
    await raw.terminate();
    const failing = harness({
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: cwdDrivers(async () => {
        throw new Error('tmux went away');
      }),
    }).runtime();
    await failing.start();
    expect(await failing.currentDirectory()).toBeNull();
    await failing.terminate();
  });
});
