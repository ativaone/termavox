import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ChunkQueue } from '../../src/transport/chunk-queue.ts';
import {
  DEFAULT_HOST_KEY_ALGORITHMS,
  decideKeyboardInteractive,
  describeHostKey,
  hostKeyAlgorithms,
  normalizeFingerprint,
  parsePublicKeyLine,
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
    expect(hostKeyAlgorithms([])).toBeUndefined(); // nothing trusted: ssh2's own order
    expect(hostKeyAlgorithms(['ssh-rsa'])).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
    ]);
    expect(hostKeyAlgorithms(['ecdsa-sha2-nistp384', 'sk-ssh-ed25519@openssh.com'])?.[0]).toBe(
      'ecdsa-sha2-nistp384',
    );
    // Same set as ssh2's defaults: an exact list may only name algorithms ssh2 supports.
    const ssh2 = createRequire(import.meta.url)('ssh2/lib/protocol/constants.js') as {
      DEFAULT_SERVER_HOST_KEY: string[];
    };
    expect([...DEFAULT_HOST_KEY_ALGORITHMS]).toEqual(ssh2.DEFAULT_SERVER_HOST_KEY);
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
