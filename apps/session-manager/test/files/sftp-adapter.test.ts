import { EventEmitter } from 'node:events';
import { ErrorCode, type TermdockError } from '@termdock/shared';
import type { SFTPWrapper } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { SftpError, SftpStatus } from '../../src/core/types.ts';
import { openSshSftp, SshSftpSession } from '../../src/transport/ssh/sftp.ts';

type Cb = (err?: Error | null, value?: unknown) => void;

/** Enough of ssh2's SFTPWrapper: requests are answered by the test through `answer`. */
class FakeWrapper extends EventEmitter {
  readonly incoming = { state: 'open' };
  readonly outgoing = { state: 'open' };
  readonly requests: Array<{ op: string; args: unknown[]; cb: Cb }> = [];
  _extensions: Record<string, string> = {};
  ended = 0;

  #request(op: string, args: unknown[]): void {
    this.requests.push({ op, args: args.slice(0, -1), cb: args.at(-1) as Cb });
  }

  realpath(...args: unknown[]): void {
    this.#request('realpath', args);
  }
  stat(...args: unknown[]): void {
    this.#request('stat', args);
  }
  lstat(...args: unknown[]): void {
    this.#request('lstat', args);
  }
  readdir(...args: unknown[]): void {
    this.#request('readdir', args);
  }
  rename(...args: unknown[]): void {
    this.#request('rename', args);
  }
  ext_openssh_rename(...args: unknown[]): void {
    this.#request('posixRename', args);
  }
  end(): void {
    this.ended++;
    this.outgoing.state = 'closing';
  }

  /** What ssh2 does when the channel closes: mark it, fail what is pending, then emit. */
  closeChannel(): void {
    this.incoming.state = 'closed';
    for (const request of this.requests.splice(0)) {
      request.cb(new Error('No response from server'));
    }
    this.emit('end');
    this.emit('close');
  }

  last(): { op: string; args: unknown[]; cb: Cb } {
    return this.requests.at(-1)!;
  }
}

const session = (wrapper = new FakeWrapper()) => ({
  wrapper,
  sftp: new SshSftpSession(wrapper as unknown as SFTPWrapper),
});
const codeOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (err: unknown) => (err as TermdockError).code,
  );

describe('opening the sftp subsystem', () => {
  const opening = (answer: (cb: Cb) => void, connected = true, timeoutMs?: number) =>
    openSshSftp(
      { sftp: (cb) => answer(cb as Cb) },
      { connected: () => connected, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    );

  it('maps a refused or dying subsystem to SFTP_UNAVAILABLE', async () => {
    for (const message of [
      'Unable to start subsystem: sftp',
      'Received exit code 127 while establishing SFTP session',
      'Received unexpected SFTP session termination',
    ]) {
      const err = (await opening((cb) => cb(new Error(message))).catch((e) => e)) as TermdockError;
      expect(err.code).toBe(ErrorCode.SftpUnavailable);
      expect(err.message).toContain(message);
    }
  });

  it('tells a gone connection and a refused channel apart from a missing subsystem', async () => {
    expect(
      await codeOf(opening((cb) => cb(new Error('Unable to start subsystem: sftp')), false)),
    ).toBe(ErrorCode.SessionNotConnected);
    const refused = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 4,
    });
    expect(await codeOf(opening((cb) => cb(refused)))).toBe(ErrorCode.FileOpFailed);
    expect(
      await codeOf(
        opening(() => {
          throw new Error('Not connected');
        }),
      ),
    ).toBe(ErrorCode.SessionNotConnected);
  });

  it('gives up on a server that never starts SFTP, and closes a channel that comes late', async () => {
    let late: Cb | null = null;
    expect(await codeOf(opening((cb) => (late = cb), true, 20))).toBe(ErrorCode.SftpUnavailable);
    const wrapper = new FakeWrapper();
    late!(undefined, wrapper);
    expect(wrapper.ended).toBe(1);
  });

  it('resolves with a session over the channel', async () => {
    const wrapper = new FakeWrapper();
    wrapper._extensions = { 'posix-rename@openssh.com': '1' };
    const sftp = await opening((cb) => cb(undefined, wrapper));
    expect(sftp.supportsPosixRename).toBe(true);
    expect(sftp.closed).toBe(false);
  });
});

describe('the sftp session adapter', () => {
  it('keeps the server status and message of a failed request', async () => {
    const { wrapper, sftp } = session();
    const pending = sftp.lstat('/nope').catch((e: unknown) => e);
    wrapper.last().cb(Object.assign(new Error('No such file'), { code: SftpStatus.NoSuchFile }));
    const err = (await pending) as SftpError;
    expect(err).toBeInstanceOf(SftpError);
    expect(err.status).toBe(SftpStatus.NoSuchFile);
    expect(err.message).toBe('No such file');
  });

  it('converts attributes (missing fields read 0) and folder pages (EOF ends them)', async () => {
    const { wrapper, sftp } = session();
    const stat = sftp.stat('/f');
    wrapper.last().cb(null, { mode: 0o100644, size: 12, mtime: 1_700_000_000, uid: 1 });
    expect(await stat).toEqual({ mode: 0o100644, size: 12, mtime: 1_700_000_000 });
    const partial = sftp.lstat('/g');
    wrapper.last().cb(null, { mode: 0o040755 });
    expect(await partial).toEqual({ mode: 0o040755, size: 0, mtime: 0 });

    const handle = new Uint8Array([1, 2, 3]);
    const page = sftp.readdir(handle);
    expect(Buffer.isBuffer(wrapper.last().args[0])).toBe(true);
    wrapper.last().cb(null, [{ filename: 'a', longname: '-rw a', attrs: { mode: 0o100600 } }]);
    expect(await page).toEqual([{ name: 'a', attrs: { mode: 0o100600, size: 0, mtime: 0 } }]);
    const end = sftp.readdir(handle);
    wrapper.last().cb(Object.assign(new Error('End of file'), { code: SftpStatus.Eof }));
    expect(await end).toBeNull();
  });

  it('fails requests cut by the close, and new ones at once (CONNECTION_LOST)', async () => {
    const { wrapper, sftp } = session();
    const closed: string[] = [];
    sftp.onClose(() => closed.push('closed'));
    const pending = sftp.realpath('.').catch((e: unknown) => e);
    wrapper.closeChannel();
    expect(((await pending) as SftpError).status).toBe(SftpStatus.ConnectionLost);
    expect(closed).toEqual(['closed']);
    expect(sftp.closed).toBe(true);
    const after = sftp.stat('/x').catch((e: unknown) => e);
    expect(((await after) as SftpError).status).toBe(SftpStatus.ConnectionLost);
    expect(wrapper.requests).toEqual([]); // never sent: ssh2 would never answer it
  });

  it('survives a fatal protocol error event and treats the channel as closed', async () => {
    const { wrapper, sftp } = session();
    expect(() => wrapper.emit('error', new Error('Invalid packet length'))).not.toThrow();
    expect(sftp.closed).toBe(true);
    expect(((await sftp.lstat('/').catch((e: unknown) => e)) as SftpError).status).toBe(
      SftpStatus.ConnectionLost,
    );
  });

  it('ends the channel once, and offers posix-rename only when the server does', async () => {
    const { wrapper, sftp } = session();
    expect(sftp.supportsPosixRename).toBe(false);
    expect(((await sftp.posixRename('/a', '/b').catch((e) => e)) as SftpError).status).toBe(
      SftpStatus.OpUnsupported,
    );
    let calls = 0;
    sftp.onClose(() => calls++);
    sftp.end();
    sftp.end();
    expect(wrapper.ended).toBe(1);
    expect(calls).toBe(1);
    const late: string[] = [];
    sftp.onClose(() => late.push('late'));
    await Promise.resolve();
    expect(late).toEqual(['late']);
  });
});
