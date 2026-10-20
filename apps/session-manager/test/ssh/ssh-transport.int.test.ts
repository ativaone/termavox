// T1: SshTransport against the test sshd containers (core images).
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { lookup } from 'node:dns/promises';
import { ErrorCode, TermavoxError } from '@termavox/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TransportError } from '../../src/core/types.ts';
import { type ResolveAll, type SshTransport, TargetPolicy } from '../../src/transport/ssh/index.ts';
import {
  HOST_KEY,
  requireSshd,
  runExec,
  type SshdImage,
  sshdTransport,
  TEST_PASSWORD,
  USER_KEY_PASSPHRASE,
  USER_KEY_WITH_PASSPHRASE,
} from './sshd.ts';

const CORE: SshdImage[] = ['no-tmux', 'tmux-3.2a', 'tmux-edge'];
const open: SshTransport[] = [];

function transport(...args: Parameters<typeof sshdTransport>): SshTransport {
  const t = sshdTransport(...args);
  open.push(t);
  return t;
}

async function connectError(t: SshTransport): Promise<unknown> {
  return t.connect(AbortSignal.timeout(15_000)).then(
    () => new Error('connect unexpectedly succeeded'),
    (err: unknown) => err,
  );
}

beforeAll(() => requireSshd(CORE));
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

describe.each(CORE)('SshTransport (%s)', (image) => {
  it('authenticates with a key, verifies the host key and runs exec without a PTY', async () => {
    const seen: string[] = [];
    const t = transport(image, {
      verifyHostKey: (key) => {
        seen.push(key.fingerprint);
        return key.fingerprint === HOST_KEY.fingerprint ? 'trusted' : 'mismatch';
      },
    });
    await t.connect(AbortSignal.timeout(15_000));
    expect(seen).toEqual([HOST_KEY.fingerprint]);
    const result = await runExec(
      t,
      "exec sh -c 'printf out; printf err >&2; if [ -t 0 ]; then echo tty; fi; exit 3'",
    );
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exit: { code: 3, signal: null } });
  });

  it('authenticates with a password', async () => {
    const t = transport(image, { credential: { kind: 'password', password: TEST_PASSWORD } });
    await t.connect(AbortSignal.timeout(15_000));
    expect((await runExec(t, 'id -un')).stdout.trim()).toBe('tv');
  });

  it('rejects an unknown host key without authenticating and reports it as pending', async () => {
    const err = await connectError(transport(image, { verifyHostKey: () => 'unknown' }));
    expect(err).toBeInstanceOf(TermavoxError);
    expect((err as TermavoxError).code).toBe(ErrorCode.HostKeyRejected);
    expect((err as TermavoxError).details).toEqual({ pending: HOST_KEY });
  });

  it('fails on a host key mismatch', async () => {
    const err = await connectError(transport(image, { verifyHostKey: () => 'mismatch' }));
    expect((err as TermavoxError).code).toBe(ErrorCode.HostKeyMismatch);
  });
});

describe('SshTransport authentication and lifecycle (tmux-3.2a)', () => {
  const image: SshdImage = 'tmux-3.2a';

  it('accepts a passphrase-protected key and rejects a wrong passphrase as CREDENTIAL_INVALID', async () => {
    const good = transport(image, {
      credential: {
        kind: 'private_key',
        privateKey: USER_KEY_WITH_PASSPHRASE,
        passphrase: USER_KEY_PASSPHRASE,
      },
    });
    await good.connect(AbortSignal.timeout(15_000));
    const err = await connectError(
      transport(image, {
        credential: {
          kind: 'private_key',
          privateKey: USER_KEY_WITH_PASSPHRASE,
          passphrase: 'wrong',
        },
      }),
    );
    expect((err as TermavoxError).code).toBe(ErrorCode.CredentialInvalid);
  });

  it('rejects a wrong password as AUTH_REJECTED', async () => {
    const err = await connectError(
      transport(image, { credential: { kind: 'password', password: 'wrong-password' } }),
    );
    expect(err).toBeInstanceOf(TermavoxError);
    expect((err as TermavoxError).code).toBe(ErrorCode.AuthRejected);
  });

  it('reports an unreachable host as a retryable transport error', async () => {
    const t = transport(image, { port: 1 });
    const err = await connectError(t);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ code: ErrorCode.HostUnreachable, retryable: true });
  });

  it('opens a PTY and resizes it', async () => {
    const t = transport(image);
    await t.connect(AbortSignal.timeout(15_000));
    const pty = await t.openPty({ cols: 81, rows: 23, term: 'xterm-256color' });
    let text = '';
    const drained = (async () => {
      for await (const chunk of pty.stdout) text += Buffer.from(chunk).toString('utf8');
    })();
    pty.write(new TextEncoder().encode('stty size; echo "T=$TERM"\n'));
    await expect.poll(() => text, { timeout: 5_000 }).toContain('T=xterm-256color');
    expect(text).toContain('23 81');
    pty.resize({ cols: 100, rows: 30 });
    pty.write(new TextEncoder().encode('stty size; exit\n'));
    await drained;
    expect(text).toContain('30 100');
    expect((await pty.exit).code).toBe(0);
  });

  it('fires onLost (retryable) when an established connection drops, not on close()', async () => {
    const dropped = transport(image);
    const lost: TransportError[] = [];
    dropped.onLost((err) => lost.push(err));
    await dropped.connect(AbortSignal.timeout(15_000));
    // Kill this connection's sshd session process from inside the session.
    const channel = await dropped.exec('kill -9 $PPID');
    await channel.exit;
    await expect.poll(() => lost.length, { timeout: 10_000 }).toBe(1);
    expect(lost[0]).toBeInstanceOf(TransportError);
    expect(lost[0]).toMatchObject({ code: 'CONNECTION_LOST', retryable: true });

    const closed = transport(image);
    const notLost: TransportError[] = [];
    closed.onLost((err) => notLost.push(err));
    await closed.connect(AbortSignal.timeout(15_000));
    await closed.close();
    expect(notLost).toEqual([]);
  });

  it('aborts a pending connect', async () => {
    const controller = new AbortController();
    const pending = transport(image).connect(controller.signal);
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
  });
});

describe('SSH target policy over a real connection (L4)', () => {
  it('connects to a host name through the policy lookup; the default policy refuses it', async () => {
    const resolved: string[] = [];
    const resolve: ResolveAll = async (hostname, options) => {
      const addresses = await lookup(hostname, { ...options, all: true });
      resolved.push(...addresses.map((a) => a.address));
      return addresses;
    };
    const allowed = transport('no-tmux', {
      host: 'localhost',
      targetPolicy: new TargetPolicy({ allowLocalTargets: true, resolve }),
    });
    await allowed.connect(AbortSignal.timeout(15_000));
    expect((await runExec(allowed, 'echo ok')).stdout).toBe('ok\n');
    expect(resolved).toContain('127.0.0.1');

    const refused = transport('no-tmux', {
      host: 'localhost',
      targetPolicy: new TargetPolicy({ allowLocalTargets: false }),
    });
    expect(await connectError(refused)).toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
  });
});
