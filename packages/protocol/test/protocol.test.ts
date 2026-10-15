import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeFrame,
  FrameType,
  NonceCache,
  parseClientMessage,
  signTicket,
  toSessionStatus,
  verifyTicket,
  WorkspaceLayout,
} from '../src/index.ts';

describe('binary frames', () => {
  it('round-trips every frame type with large channel and seq values', () => {
    for (const type of Object.values(FrameType)) {
      const frame = {
        type,
        flags: 1,
        channel: 0xffff_fffe,
        seq: 0xffff_ffff_ffffn,
        payload: new Uint8Array([0, 27, 255, 10]),
      };
      const withSize =
        type === FrameType.Snapshot ? { ...frame, size: { cols: 512, rows: 65535 } } : frame;
      expect(decodeFrame(encodeFrame(withSize))).toEqual(withSize);
    }
  });

  it('rejects short and unknown frames', () => {
    expect(() => decodeFrame(new Uint8Array(5))).toThrow();
    expect(() => decodeFrame(new Uint8Array(14).fill(9))).toThrow();
  });
});

describe('control messages', () => {
  it('ignores unknown types but rejects malformed known types', () => {
    expect(parseClientMessage('{"type":"future.thing","x":1}')).toBeNull();
    expect(() => parseClientMessage('{"type":"session.detach","channel":-1}')).toThrow();
    expect(parseClientMessage('{"type":"terminal.activate","channel":3}')).toEqual({
      type: 'terminal.activate',
      channel: 3,
    });
  });
});

describe('ws tickets', () => {
  const secret = new Uint8Array(32).fill(7);
  const claims = { uid: 'u1', asid: 'a1' };

  it('accepts a fresh ticket exactly once', () => {
    const nonces = new NonceCache();
    const ticket = signTicket(secret, claims, 1_000);
    expect(verifyTicket(secret, ticket, nonces, 2_000)).toMatchObject({
      ok: true,
      payload: claims,
    });
    expect(verifyTicket(secret, ticket, nonces, 2_000)).toEqual({ ok: false, error: 'replayed' });
  });

  it('rejects expired, tampered and foreign-key tickets', () => {
    const ticket = signTicket(secret, claims, 1_000);
    expect(verifyTicket(secret, ticket, new NonceCache(), 40_000)).toEqual({
      ok: false,
      error: 'expired',
    });
    const [body, sig] = ticket.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), uid: 'u2' })).toString('base64url')}.${sig}`;
    expect(verifyTicket(secret, forged, new NonceCache(), 2_000)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
    expect(verifyTicket(new Uint8Array(32), ticket, new NonceCache(), 2_000)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });
});

describe('session status mapping', () => {
  it('distinguishes first connect from restore', () => {
    expect(toSessionStatus('syncing', false)).toBe('connecting');
    expect(toSessionStatus('syncing', true)).toBe('restoring');
    expect(toSessionStatus('awaiting_host_key', false)).toBe('action_required');
    expect(toSessionStatus('failed', true)).toBe('disconnected');
  });
});

describe('layout schema', () => {
  it('requires sizes to match children', () => {
    const leaf = (id: string) => ({ type: 'leaf' as const, id, sessionId: null });
    const ok = {
      version: 1,
      activeTabId: 't',
      tabs: [
        {
          id: 't',
          activePaneId: 'a',
          root: {
            type: 'split',
            id: 's',
            direction: 'row',
            sizes: [1, 1],
            children: [leaf('a'), leaf('b')],
          },
        },
      ],
    };
    expect(WorkspaceLayout.safeParse(ok).success).toBe(true);
    const bad = structuredClone(ok);
    bad.tabs[0]!.root.sizes = [1, 1, 1];
    expect(WorkspaceLayout.safeParse(bad).success).toBe(false);
  });
});

describe('fingerprint normalization', () => {
  it('accepts pasted OpenSSH fingerprints with or without prefix and padding', async () => {
    const { Fingerprint } = await import('../src/index.ts');
    const raw = 'nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';
    expect(Fingerprint.parse(`SHA256:${raw}=`)).toBe(`SHA256:${raw}`);
    expect(Fingerprint.parse(` ${raw} `)).toBe(`SHA256:${raw}`);
    expect(Fingerprint.safeParse('MD5:aa:bb').success).toBe(false);
  });
});
