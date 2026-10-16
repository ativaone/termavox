import { afterEach, describe, expect, it } from 'vitest';
import { decideHostKey, type TransportFactory } from '../../src/core/transport-factory.ts';
import type { PresentedHostKey, Transport } from '../../src/core/types.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import {
  auditHostKeyMismatches,
  PENDING_TTL_MS,
  SqliteHostKeyStore,
} from '../../src/store/host-key-store.ts';
import { makeRecord } from '../runtime/fakes.ts';
import { auditTypes, insertHost, insertUser, type TempDb, tempDb } from './fixture.ts';

const key = (n: string, type = 'ssh-ed25519'): PresentedHostKey => ({
  type,
  fingerprint: `SHA256:${n.repeat(43).slice(0, 43)}`,
  publicKeyB64: `AAAA${n}`,
});

let fixture: TempDb;
afterEach(() => fixture?.cleanup());

function setup() {
  fixture = tempDb();
  const { db } = fixture;
  const writer = new BatchedWriter(db);
  let clock = 1_000_000;
  const store = new SqliteHostKeyStore(db, writer, { now: () => clock });
  const userId = insertUser(db);
  const hostId = insertHost(db, userId);
  const trustedRows = (keyType = 'ssh-ed25519') =>
    db.$client
      .prepare(
        "SELECT fingerprint_sha256 AS fp FROM known_host_keys WHERE host_id = ? AND key_type = ? AND status = 'trusted'",
      )
      .all(hostId, keyType) as Array<{ fp: string }>;
  return {
    db,
    writer,
    store,
    userId,
    hostId,
    trustedRows,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('SqliteHostKeyStore', () => {
  it('trusts a pending key once, keeps a single trusted key per type and audits each step', async () => {
    const { db, writer, store, userId, hostId, trustedRows } = setup();
    const a = key('A');
    await store.recordPending(hostId, a);
    await store.recordPending(hostId, a); // same key again: no duplicate row, no second audit
    expect(await store.trustPending(hostId, a.fingerprint, userId)).toBe(true);
    expect((await store.trusted(hostId)).get('ssh-ed25519')).toEqual(a);

    // Another key of the same type cannot become trusted through trust-key or the prompt.
    const b = key('B');
    await store.recordPending(hostId, b);
    expect(await store.trustPending(hostId, b.fingerprint, userId)).toBe(false);
    expect(
      await store.trust(hostId, {
        fingerprint: b.fingerprint,
        keyType: b.type,
        decidedBy: userId,
        allowPreTrust: true,
      }),
    ).toBe('conflict');
    expect(trustedRows()).toEqual([{ fp: a.fingerprint }]);

    // Only replace-key changes it: the old key is revoked, the pending one promoted.
    await store.replace(hostId, b.type, b.fingerprint, userId);
    expect(trustedRows()).toEqual([{ fp: b.fingerprint }]);
    expect((await store.trusted(hostId)).get('ssh-ed25519')?.publicKeyB64).toBe(b.publicKeyB64);

    // A pasted fingerprint of another type is pre-trusted without a public key.
    const pasted = key('C', 'ecdsa-sha2-nistp256');
    expect(
      await store.trust(hostId, {
        fingerprint: pasted.fingerprint,
        keyType: pasted.type,
        decidedBy: userId,
        allowPreTrust: true,
      }),
    ).toBe('trusted');
    expect((await store.trusted(hostId)).get(pasted.type)?.publicKeyB64).toBe('');

    expect(await store.revoke(hostId, 'ssh-ed25519', userId)).toBe(true);
    expect(await store.revoke(hostId, 'ssh-ed25519', userId)).toBe(false);
    expect(trustedRows()).toEqual([]);

    store.recordMismatch(hostId, key('D'), userId, { sessionId: 's1' });
    await writer.flush();
    expect(auditTypes(db)).toEqual([
      'host_key.pending',
      'host_key.trust',
      'host_key.pending',
      'host_key.replace',
      'host_key.trust',
      'host_key.revoke',
      'host_key.mismatch',
    ]);
    const statuses = (await store.list(hostId)).map((k) => `${k.keyType}:${k.status}`).sort();
    expect(statuses).toEqual([
      'ecdsa-sha2-nistp256:trusted',
      'ssh-ed25519:revoked',
      'ssh-ed25519:revoked',
    ]);
  });

  it('pending keys expire 24 h after first_seen_at: trustPending is false afterwards', async () => {
    const { store, userId, hostId, advance } = setup();
    const a = key('A');
    await store.recordPending(hostId, a);
    advance(PENDING_TTL_MS - 1);
    await store.recordPending(hostId, a); // seen again: first_seen_at is kept, not refreshed
    advance(1);
    expect((await store.list(hostId))[0]).toMatchObject({ status: 'pending', expired: true });
    expect(await store.trustPending(hostId, a.fingerprint, userId)).toBe(false);
    expect(
      await store.trust(hostId, {
        fingerprint: a.fingerprint,
        decidedBy: userId,
        allowPreTrust: false,
      }),
    ).toBe('no_match');
    expect((await store.trusted(hostId)).size).toBe(0);

    // Seen again after expiry: a fresh pending row that can be trusted.
    await store.recordPending(hostId, a);
    expect(await store.trustPending(hostId, a.fingerprint, userId)).toBe(true);
  });

  it('a matched pasted pre-trust fingerprint learns its public key; nothing else changes', async () => {
    const { db, store, userId, hostId } = setup();
    const a = key('A');
    const outcome = await store.trust(hostId, {
      fingerprint: a.fingerprint,
      keyType: a.type,
      decidedBy: userId,
      allowPreTrust: true,
    });
    expect(outcome).toBe('trusted');
    expect((await store.list(hostId))[0]?.publicKeyB64).toBeNull();
    await store.rememberPublicKey(hostId, { ...key('B'), type: a.type }); // another key: ignored
    await store.rememberPublicKey(hostId, a);
    await store.rememberPublicKey(hostId, { ...a, publicKeyB64: 'AAAAother' }); // already known
    expect(await store.list(hostId)).toMatchObject([
      {
        keyType: a.type,
        fingerprint: a.fingerprint,
        publicKeyB64: a.publicKeyB64,
        status: 'trusted',
      },
    ]);
    expect(auditTypes(db)).toEqual(['host_key.trust']);
  });

  it('audits mismatches seen by session handshakes and passes every decision through', async () => {
    const { db, writer, store, userId, hostId } = setup();
    const presented = key('M');
    const inner: TransportFactory = {
      async create(_record, hooks) {
        hooks.onHostKey(presented, 'mismatch');
        hooks.onHostKey(presented, 'trusted');
        return {} as Transport;
      },
    };
    const decisions: string[] = [];
    const record = makeRecord({ id: 's1', userId });
    await auditHostKeyMismatches(inner, store).create(
      { ...record, target: { ...record.target, hostId } },
      {
        onHostKey: (_key, decision) => decisions.push(decision),
        onKeyboardInteractive: async () => null,
      },
    );
    await writer.flush();
    expect(decisions).toEqual(['mismatch', 'trusted']);
    expect(auditTypes(db)).toEqual(['host_key.mismatch']);
    const detail = db.$client
      .prepare('SELECT actor_user_id, detail_json FROM audit_events')
      .get() as {
      actor_user_id: string;
      detail_json: string;
    };
    expect(detail.actor_user_id).toBe(userId);
    expect(JSON.parse(detail.detail_json)).toEqual({
      keyType: presented.type,
      fingerprint: presented.fingerprint,
      sessionId: 's1',
    });
  });

  it('a revoked key fails closed: never pending or trusted again except through replace-key (M2)', async () => {
    const { db, writer, store, userId, hostId, trustedRows } = setup();
    const a = key('A');
    await store.recordPending(hostId, a);
    expect(await store.trustPending(hostId, a.fingerprint, userId)).toBe(true);
    expect(await store.revoke(hostId, a.type, userId)).toBe(true);
    expect(await store.revoked(hostId)).toEqual(new Set([a.fingerprint]));

    // The server presents it again: revoked, not unknown, even though nothing is trusted.
    const [trusted, revoked] = [await store.trusted(hostId), await store.revoked(hostId)];
    expect(trusted.size).toBe(0);
    expect(decideHostKey(trusted, a, revoked)).toBe('revoked');
    // A brand-new key after the revocation is a first use again (a rotated server).
    expect(decideHostKey(trusted, key('N'), revoked)).toBe('unknown');

    // No prompt can offer it, and neither the prompt, trust-key nor pre-trust accepts it.
    await store.recordPending(hostId, a);
    expect((await store.list(hostId)).filter((k) => k.status === 'pending')).toEqual([]);
    expect(await store.trustPending(hostId, a.fingerprint, userId)).toBe(false);
    const pasted = { fingerprint: a.fingerprint, keyType: a.type, decidedBy: userId };
    expect(await store.trust(hostId, { ...pasted, allowPreTrust: true })).toBe('revoked');
    expect(await store.trust(hostId, { ...pasted, allowPreTrust: false })).toBe('no_match');
    expect(trustedRows()).toEqual([]);

    // A pending row of it left over from before the fix cannot be promoted either.
    db.$client
      .prepare(
        `INSERT INTO known_host_keys (id, host_id, key_type, public_key_b64, fingerprint_sha256, status, first_seen_at)
         VALUES ('stale', ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(hostId, a.type, a.publicKeyB64, a.fingerprint, 1_000_000);
    expect(await store.trustPending(hostId, a.fingerprint, userId)).toBe(false);
    expect(trustedRows()).toEqual([]);

    // replace-key (host name confirmed by the route) is the explicit way back.
    await store.replace(hostId, a.type, a.fingerprint, userId);
    expect(trustedRows()).toEqual([{ fp: a.fingerprint }]);
    const after = await store.trusted(hostId);
    expect(decideHostKey(after, a, await store.revoked(hostId))).toBe('trusted');
    expect(await store.trust(hostId, { ...pasted, allowPreTrust: true })).toBe('already_trusted');

    store.recordRevokedPresented(hostId, a, userId, { source: 'host_test' });
    await writer.flush();
    expect(auditTypes(db)).toContain('host_key.revoked_presented');
    expect(auditTypes(db).filter((t) => t === 'host_key.pending')).toHaveLength(1);
  });

  it('audits a revoked key seen by a session handshake as host_key.revoked_presented', async () => {
    const { db, writer, store, userId, hostId } = setup();
    const presented = key('R');
    const inner: TransportFactory = {
      async create(_record, hooks) {
        hooks.onHostKey(presented, 'revoked');
        return {} as Transport;
      },
    };
    const decisions: string[] = [];
    const record = makeRecord({ id: 's1', userId });
    await auditHostKeyMismatches(inner, store).create(
      { ...record, target: { ...record.target, hostId } },
      {
        onHostKey: (_key, decision) => decisions.push(decision),
        onKeyboardInteractive: async () => null,
      },
    );
    await writer.flush();
    expect(decisions).toEqual(['revoked']);
    expect(auditTypes(db)).toEqual(['host_key.revoked_presented']);
  });
});
