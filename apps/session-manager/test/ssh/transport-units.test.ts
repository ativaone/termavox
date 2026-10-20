import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { decideHostKey } from '../../src/core/transport-factory.ts';
import { ChunkQueue } from '../../src/transport/chunk-queue.ts';
import {
  classifyTarget,
  DEFAULT_HOST_KEY_ALGORITHMS,
  decideKeyboardInteractive,
  describeHostKey,
  hostKeyAlgorithms,
  normalizeFingerprint,
  parsePublicKeyLine,
  SshTransport,
  TargetPolicy,
} from '../../src/transport/ssh/index.ts';
import { HOST_KEY } from './sshd.ts';

describe('host keys', () => {
  it('computes the OpenSSH SHA256 fingerprint and type from the key blob', () => {
    // Value printed by `ssh-keygen -lf test/sshd/keys/ssh_host_ed25519_key.pub`.
    expect(HOST_KEY.fingerprint).toBe('SHA256:6AKabYDKazOSI5KmhV+r75VtW0R9OgAQruCvlIUzYvI');
    expect(HOST_KEY.type).toBe('ssh-ed25519');
    expect(describeHostKey(Buffer.from(HOST_KEY.publicKeyB64, 'base64'))).toEqual(HOST_KEY);
  });

  it('rejects malformed blobs', () => {
    expect(() => describeHostKey(new Uint8Array([0, 0]))).toThrow(RangeError);
    expect(() => describeHostKey(new Uint8Array([0, 0, 0, 9, 0x61]))).toThrow(RangeError);
    expect(() => parsePublicKeyLine('ssh-ed25519')).toThrow(RangeError);
  });

  it('negotiates the trusted key types first, keeping the other defaults after them', () => {
    // Nothing trusted: still an explicit list, so ssh2's own `ssh-rsa` is never offered.
    expect(hostKeyAlgorithms([])).toEqual([...DEFAULT_HOST_KEY_ALGORITHMS]);
    expect(hostKeyAlgorithms(['ssh-rsa'])).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
    ]);
    expect(hostKeyAlgorithms(['ecdsa-sha2-nistp384', 'sk-ssh-ed25519@openssh.com'])[0]).toBe(
      'ecdsa-sha2-nistp384',
    );
    // ssh2's defaults minus SHA-1 `ssh-rsa` (L6): an exact list may only name algorithms ssh2
    // supports, and RSA host keys are verified with rsa-sha2-512/256 only.
    const ssh2 = createRequire(import.meta.url)('ssh2/lib/protocol/constants.js') as {
      DEFAULT_SERVER_HOST_KEY: string[];
    };
    expect([...DEFAULT_HOST_KEY_ALGORITHMS]).toEqual(
      ssh2.DEFAULT_SERVER_HOST_KEY.filter((a) => a !== 'ssh-rsa'),
    );
    for (const types of [[], ['ssh-rsa'], ['ssh-ed25519', 'ssh-rsa']]) {
      expect(hostKeyAlgorithms(types)).not.toContain('ssh-rsa');
    }
  });

  it('decides trusted, revoked, unknown and mismatch (M2)', () => {
    const key = (n: string, type = 'ssh-ed25519') => ({
      type,
      fingerprint: `SHA256:${n.repeat(43)}`,
      publicKeyB64: `AAAA${n}`,
    });
    const [a, b, c] = [key('a'), key('b'), key('c', 'ecdsa-sha2-nistp256')];
    const trustedA = new Map([[a.type, a]]);
    expect(decideHostKey(trustedA, a)).toBe('trusted');
    expect(decideHostKey(trustedA, b)).toBe('mismatch');
    expect(decideHostKey(trustedA, c)).toBe('mismatch'); // another type: downgrade attempt
    expect(decideHostKey(new Map(), b)).toBe('unknown');
    // Revoked: refused even with nothing trusted, and whatever else is trusted.
    expect(decideHostKey(new Map(), b, new Set([b.fingerprint]))).toBe('revoked');
    expect(decideHostKey(trustedA, b, new Set([b.fingerprint]))).toBe('revoked');
    // A new key after a revocation is a first use; a re-trusted (replaced) one is trusted.
    expect(decideHostKey(new Map(), c, new Set([b.fingerprint]))).toBe('unknown');
    expect(decideHostKey(trustedA, a, new Set([a.fingerprint]))).toBe('trusted');
  });

  it('normalizes pasted fingerprints', () => {
    const bare = '6AKabYDKazOSI5KmhV+r75VtW0R9OgAQruCvlIUzYvI';
    expect(normalizeFingerprint(`  sha256:${bare}=  `)).toBe(`SHA256:${bare}`);
    expect(normalizeFingerprint(bare)).toBe(`SHA256:${bare}`);
    expect(normalizeFingerprint('MD5:aa:bb')).toBeNull();
  });
});

describe('keyboard-interactive decision', () => {
  const password = { kind: 'password', password: 'pw' } as const;
  const key = { kind: 'private_key', privateKey: 'k' } as const;
  const prompt = (text: string) => ({ text, echo: false });

  it('auto-answers exactly one password prompt once, with a password credential', () => {
    const input = { prompts: [prompt('Password: ')], credential: password, canRelay: true };
    expect(decideKeyboardInteractive({ ...input, autoAnswered: false })).toEqual({
      kind: 'auto',
      answers: ['pw'],
    });
    // Second round (stored password wrong): never loop, ask the user.
    expect(decideKeyboardInteractive({ ...input, autoAnswered: true })).toEqual({ kind: 'relay' });
  });

  it('relays or rejects everything else', () => {
    const base = { autoAnswered: false, canRelay: true };
    expect(
      decideKeyboardInteractive({
        ...base,
        prompts: [prompt('Verification code: ')],
        credential: password,
      }),
    ).toEqual({ kind: 'relay' });
    expect(
      decideKeyboardInteractive({
        ...base,
        prompts: [prompt('Password: '), prompt('OTP: ')],
        credential: password,
      }),
    ).toEqual({ kind: 'relay' });
    expect(
      decideKeyboardInteractive({ ...base, prompts: [prompt('Password: ')], credential: key }),
    ).toEqual({ kind: 'relay' });
    expect(
      decideKeyboardInteractive({
        prompts: [prompt('OTP: ')],
        credential: null,
        autoAnswered: false,
        canRelay: false,
      }),
    ).toEqual({ kind: 'reject' });
  });
});

describe('ChunkQueue', () => {
  it('signals pressure at the high water mark and releases it at the low one', async () => {
    const pressure: boolean[] = [];
    const queue = new ChunkQueue({
      highWater: 10,
      lowWater: 4,
      onPressure: (p) => pressure.push(p),
    });
    for (let i = 0; i < 4; i++) queue.push(new Uint8Array(3));
    expect(pressure).toEqual([true]);
    const it = queue[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    expect(pressure).toEqual([true]);
    await it.next();
    expect(pressure).toEqual([true, false]);
    queue.end();
    await it.next();
    expect(await it.next()).toEqual({ done: true, value: undefined });
  });

  it('delivers chunks pushed while the consumer waits, then the end or error', async () => {
    const queue = new ChunkQueue();
    const collected = (async () => {
      const out: number[] = [];
      for await (const chunk of queue) out.push(chunk.byteLength);
      return out;
    })();
    queue.push(new Uint8Array(1));
    await Promise.resolve();
    queue.push(new Uint8Array(2));
    queue.end();
    expect(await collected).toEqual([1, 2]);

    const failing = new ChunkQueue();
    failing.end(new Error('boom'));
    await expect(failing[Symbol.asyncIterator]().next()).rejects.toThrow('boom');
    expect(() => {
      const q = new ChunkQueue();
      q[Symbol.asyncIterator]();
      q[Symbol.asyncIterator]();
    }).toThrow();
  });

  it('caps stderr-style queues by dropping the oldest chunks', () => {
    const queue = new ChunkQueue({ maxBytes: 5 });
    for (let i = 0; i < 4; i++) queue.push(new Uint8Array(2));
    expect(queue.bufferedBytes).toBe(4);
  });
});

describe('SSH target policy (L4)', () => {
  it('refuses loopback, link-local, unspecified and multicast IPv4 addresses', () => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.10',
      '169.254.169.254',
      '169.254.0.1',
      '0.0.0.0',
      '0.1.2.3',
      '224.0.0.1',
      '239.255.255.250',
    ]) {
      expect(classifyTarget(address), address).not.toBeNull();
    }
    expect(classifyTarget('127.0.0.1')).toBe('loopback');
    expect(classifyTarget('169.254.169.254')).toBe('link_local');
    expect(classifyTarget('0.0.0.0')).toBe('unspecified');
    expect(classifyTarget('224.0.0.251')).toBe('multicast');
  });

  it('allows private LAN ranges, the Docker host gateway, CGNAT and public addresses', () => {
    for (const address of [
      '10.0.0.5',
      '172.16.0.1',
      '172.17.0.1', // host.docker.internal (host-gateway)
      '172.31.255.254',
      '192.168.1.10',
      '100.64.0.1',
      '203.0.113.7',
      '8.8.8.8',
      'fc00::1',
      'fd12:3456::1',
      '2001:db8::1',
    ]) {
      expect(classifyTarget(address), address).toBeNull();
    }
  });

  it('refuses IPv6 loopback, unspecified, link-local and multicast, and IPv4-mapped forms', () => {
    expect(classifyTarget('::1')).toBe('loopback');
    expect(classifyTarget('0:0:0:0:0:0:0:1')).toBe('loopback');
    expect(classifyTarget('::')).toBe('unspecified');
    expect(classifyTarget('fe80::1')).toBe('link_local');
    expect(classifyTarget('fe80::1%eth0')).toBe('link_local');
    expect(classifyTarget('febf::1')).toBe('link_local');
    expect(classifyTarget('ff02::1')).toBe('multicast');
    expect(classifyTarget('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyTarget('::FFFF:7f00:1')).toBe('loopback');
    expect(classifyTarget('0:0:0:0:0:ffff:7f00:0001')).toBe('loopback');
    expect(classifyTarget('::ffff:169.254.169.254')).toBe('link_local');
    expect(classifyTarget('::127.0.0.1')).toBe('loopback'); // IPv4-compatible
    expect(classifyTarget('::ffff:10.0.0.1')).toBeNull();
    expect(classifyTarget('fec0::1')).toBeNull();
  });

  it("refuses the daemon's own interface addresses, in any form", () => {
    const own = ['172.30.10.3', 'fd00::3', 'fe80::42%eth0'];
    expect(classifyTarget('172.30.10.3', own)).toBe('own_address');
    expect(classifyTarget('::ffff:172.30.10.3', own)).toBe('own_address');
    expect(classifyTarget('fd00:0:0:0:0:0:0:3', own)).toBe('own_address');
    expect(classifyTarget('172.30.10.4', own)).toBeNull();
    expect(classifyTarget('not-an-ip', own)).toBeNull();
  });

  it('resolves names once and hands out only allowed addresses; the override allows all', async () => {
    const lookups: string[] = [];
    const resolve = async (hostname: string) => {
      lookups.push(hostname);
      if (hostname === 'mixed.test') {
        return [
          { address: '127.0.0.1', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ];
      }
      return [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ];
    };
    const policy = new TargetPolicy({
      allowLocalTargets: false,
      resolve,
      localAddresses: () => [],
    });
    expect(await policy.resolveAllowed('mixed.test')).toEqual([{ address: '10.0.0.5', family: 4 }]);
    await expect(policy.resolveAllowed('localhost')).rejects.toMatchObject({
      code: 'TARGET_NOT_ALLOWED',
    });
    // The socket's lookup gets the same filtered answer (single and `all` forms).
    const single = await new Promise((done) =>
      policy.lookup('mixed.test', {}, (err, address, family) => done({ err, address, family })),
    );
    expect(single).toEqual({ err: null, address: '10.0.0.5', family: 4 });
    const all = await new Promise((done) =>
      policy.lookup('mixed.test', { all: true }, (err, address) => done({ err, address })),
    );
    expect(all).toEqual({ err: null, address: [{ address: '10.0.0.5', family: 4 }] });
    expect(lookups).toEqual(['mixed.test', 'localhost', 'mixed.test', 'mixed.test']);
    // IP literals never reach the lookup (Node skips it): checked up front.
    expect(policy.target('203.0.113.7')).toBe('203.0.113.7');
    expect(policy.target('[2001:db8::1]')).toBe('2001:db8::1');
    expect(policy.target('example.test')).toBe('example.test');
    expect(() => policy.target('127.0.0.1')).toThrow(/not allowed/);
    expect(() => policy.target('[::ffff:127.0.0.1]')).toThrow(/not allowed/);

    const open = new TargetPolicy({ allowLocalTargets: true, resolve, localAddresses: () => [] });
    expect(open.target('127.0.0.1')).toBe('127.0.0.1');
    expect(await open.resolveAllowed('localhost')).toHaveLength(2);
  });

  it('a refused target fails the connect with TARGET_NOT_ALLOWED before any connection', async () => {
    const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
    const policy = new TargetPolicy({
      allowLocalTargets: false,
      resolve,
      localAddresses: () => [],
    });
    const connect = (host: string) =>
      new SshTransport({
        host,
        port: 1, // never dialled
        username: 'tv',
        credential: null,
        verifyHostKey: () => 'trusted',
        targetPolicy: policy,
        readyTimeoutMs: 5_000,
      }).connect(new AbortController().signal);
    await expect(connect('127.0.0.1')).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
    await expect(connect('loopback.test')).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
  });

  it('closes its socket when ssh2 refuses the credential before taking the socket over', async () => {
    const dialled = vi.spyOn(Socket.prototype, 'connect');
    try {
      const error = await new SshTransport({
        host: '127.0.0.1',
        port: 1,
        username: 'tv',
        credential: { kind: 'private_key', privateKey: 'not a private key' },
        verifyHostKey: () => 'trusted',
        targetPolicy: new TargetPolicy({ allowLocalTargets: true, localAddresses: () => [] }),
      })
        .connect(new AbortController().signal)
        .catch((err: unknown) => err);
      expect(error).toMatchObject({ code: 'CREDENTIAL_INVALID' });
      const sockets = dialled.mock.contexts as Socket[];
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.destroyed).toBe(true);
    } finally {
      dialled.mockRestore();
    }
  });
});
