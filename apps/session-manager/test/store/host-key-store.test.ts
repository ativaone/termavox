import { ErrorCode, TermavoxError } from '@termavox/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { decideHostKey, type TransportFactory } from '../../src/core/transport-factory.ts';
import type { HostKeyTarget, PresentedHostKey, Transport } from '../../src/core/types.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import {
  auditHostKeyMismatches,
  PENDING_TTL_MS,
  SqliteHostKeyStore,
} from '../../src/store/host-key-store.ts';
import {
  type FakeTransportBehavior,
  harness,
  makeRecord,
  TEST_KEY,
  until,
} from '../runtime/fakes.ts';
import { auditTypes, insertServer, insertUser, type TempDb, tempDb } from './fixture.ts';

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
  const serverId = insertServer(db, userId);
  // The server's address (127.0.0.1:22) as seen through it.
  const at: HostKeyTarget = { userId, hostname: '127.0.0.1', port: 22, serverId };
  const trustedRows = (keyType = 'ssh-ed25519') =>
    db.$client
      .prepare(
        "SELECT fingerprint_sha256 AS fp FROM known_host_keys WHERE user_id = ? AND hostname = '127.0.0.1' AND port = 22 AND key_type = ? AND status = 'trusted'",
      )
      .all(userId, keyType) as Array<{ fp: string }>;
  const audits = () =>
    (
      db.$client
        .prepare(
          'SELECT type, actor_user_id, target_type, target_id, detail_json FROM audit_events ORDER BY rowid',
        )
        .all() as Array<Record<string, string | null>>
    ).map((r) => ({ ...r, detail_json: JSON.parse(r.detail_json ?? 'null') }));
  return {
    db,
    writer,
    store,
    userId,
    serverId,
    at,
    trustedRows,
    audits,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('SqliteHostKeyStore', () => {
  it('trusts a pending key once, keeps a single trusted key per type and audits each step', async () => {
    const { db, writer, store, userId, at, trustedRows } = setup();
    const a = key('A');
    await store.recordPending(at, a);
    await store.recordPending(at, a); // same key again: no duplicate row, no second audit
    expect(await store.trustPending(at, a.fingerprint, userId)).toBe(true);
    expect((await store.trusted(at)).get('ssh-ed25519')).toEqual(a);

    // Another key of the same type cannot become trusted through trust-key or the prompt.
    const b = key('B');
    await store.recordPending(at, b);
    expect(await store.trustPending(at, b.fingerprint, userId)).toBe(false);
    expect(
      await store.trust(at, {
        fingerprint: b.fingerprint,
        keyType: b.type,
        decidedBy: userId,
        allowPreTrust: true,
      }),
    ).toBe('conflict');
    expect(trustedRows()).toEqual([{ fp: a.fingerprint }]);

    // Only replace-key changes it: the old key is revoked, the pending one promoted.
    await store.replace(at, b.type, b.fingerprint, userId);
    expect(trustedRows()).toEqual([{ fp: b.fingerprint }]);
    expect((await store.trusted(at)).get('ssh-ed25519')?.publicKeyB64).toBe(b.publicKeyB64);

    // A pasted fingerprint of another type is pre-trusted without a public key.
    const pasted = key('C', 'ecdsa-sha2-nistp256');
    expect(
      await store.trust(at, {
        fingerprint: pasted.fingerprint,
        keyType: pasted.type,
        decidedBy: userId,
        allowPreTrust: true,
      }),
    ).toBe('trusted');
    expect((await store.trusted(at)).get(pasted.type)?.publicKeyB64).toBe('');

    expect(await store.revoke(at, 'ssh-ed25519', userId)).toBe(true);
    expect(await store.revoke(at, 'ssh-ed25519', userId)).toBe(false);
    expect(trustedRows()).toEqual([]);

    store.recordMismatch(at, key('D'), userId, { sessionId: 's1' });
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
    const statuses = (await store.list(at)).map((k) => `${k.keyType}:${k.status}`).sort();
    expect(statuses).toEqual([
      'ecdsa-sha2-nistp256:trusted',
      'ssh-ed25519:revoked',
      'ssh-ed25519:revoked',
    ]);
  });

  it('audits every decision against the server that triggered it, with the address', async () => {
    const { writer, store, userId, serverId, at, audits } = setup();
    const a = key('A');
    await store.recordPending(at, a);
    await store.trust(at, { fingerprint: a.fingerprint, decidedBy: userId, allowPreTrust: false });
    store.recordMismatch({ ...at, serverId: null }, key('M'), userId, { sessionId: 's1' });
    await writer.flush();
    const address = { hostname: '127.0.0.1', port: 22 };
    expect(audits()).toEqual([
      {
        type: 'host_key.pending',
        actor_user_id: null,
        target_type: 'server',
        target_id: serverId,
        detail_json: { keyType: a.type, fingerprint: a.fingerprint, ...address },
      },
      {
        type: 'host_key.trust',
        actor_user_id: userId,
        target_type: 'server',
        target_id: serverId,
        detail_json: { keyType: a.type, fingerprint: a.fingerprint, source: 'pending', ...address },
      },
      // Seen by a session whose server is gone: no target, the address still recorded.
      {
        type: 'host_key.mismatch',
        actor_user_id: userId,
        target_type: 'server',
        target_id: null,
        detail_json: {
          keyType: 'ssh-ed25519',
          fingerprint: key('M').fingerprint,
          sessionId: 's1',
          ...address,
        },
      },
    ]);
  });

  it('pending keys expire 24 h after first_seen_at: trustPending is false afterwards', async () => {
    const { store, userId, at, advance } = setup();
    const a = key('A');
    await store.recordPending(at, a);
    advance(PENDING_TTL_MS - 1);
    await store.recordPending(at, a); // seen again: first_seen_at is kept, not refreshed
    advance(1);
    expect((await store.list(at))[0]).toMatchObject({ status: 'pending', expired: true });
    expect(await store.trustPending(at, a.fingerprint, userId)).toBe(false);
    expect(
      await store.trust(at, {
        fingerprint: a.fingerprint,
        decidedBy: userId,
        allowPreTrust: false,
      }),
    ).toBe('no_match');
    expect((await store.trusted(at)).size).toBe(0);

    // Seen again after expiry: a fresh pending row that can be trusted.
    await store.recordPending(at, a);
    expect(await store.trustPending(at, a.fingerprint, userId)).toBe(true);
  });

  it('a matched pasted pre-trust fingerprint learns its public key; nothing else changes', async () => {
    const { db, store, userId, at } = setup();
    const a = key('A');
    const outcome = await store.trust(at, {
      fingerprint: a.fingerprint,
      keyType: a.type,
      decidedBy: userId,
      allowPreTrust: true,
    });
    expect(outcome).toBe('trusted');
    expect((await store.list(at))[0]?.publicKeyB64).toBeNull();
    await store.rememberPublicKey(at, { ...key('B'), type: a.type }); // another key: ignored
    await store.rememberPublicKey(at, a);
    await store.rememberPublicKey(at, { ...a, publicKeyB64: 'AAAAother' }); // already known
    expect(await store.list(at)).toMatchObject([
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
    const { db, writer, store, userId, serverId } = setup();
    const presented = key('M');
    const inner: TransportFactory = {
      async create(_record, hooks) {
        hooks.onHostKey(presented, 'mismatch');
        hooks.onHostKey(presented, 'trusted');
        return {} as Transport;
      },
    };
    const decisions: string[] = [];
    const record = makeRecord({ id: 's1', userId, serverId });
    await auditHostKeyMismatches(inner, store).create(
      { ...record, target: { ...record.target, hostname: 'Box.Example', port: 2222 } },
      {
        onHostKey: (_key, decision) => decisions.push(decision),
        onKeyboardInteractive: async () => null,
      },
    );
    await writer.flush();
    expect(decisions).toEqual(['mismatch', 'trusted']);
    expect(auditTypes(db)).toEqual(['host_key.mismatch']);
    const row = db.$client
      .prepare('SELECT actor_user_id, target_type, target_id, detail_json FROM audit_events')
      .get() as Record<string, string>;
    expect(row).toMatchObject({
      actor_user_id: userId,
      target_type: 'server',
      target_id: serverId,
    });
    expect(JSON.parse(row.detail_json!)).toEqual({
      keyType: presented.type,
      fingerprint: presented.fingerprint,
      sessionId: 's1',
      hostname: 'box.example',
      port: 2222,
    });
  });

  it('a revoked key fails closed: never pending or trusted again except through replace-key (M2)', async () => {
    const { db, writer, store, userId, at, trustedRows } = setup();
    const a = key('A');
    await store.recordPending(at, a);
    expect(await store.trustPending(at, a.fingerprint, userId)).toBe(true);
    expect(await store.revoke(at, a.type, userId)).toBe(true);
    expect(await store.revoked(at)).toEqual(new Set([a.fingerprint]));

    // The server presents it again: revoked, not unknown, even though nothing is trusted.
    const [trusted, revoked] = [await store.trusted(at), await store.revoked(at)];
    expect(trusted.size).toBe(0);
    expect(decideHostKey(trusted, a, revoked)).toBe('revoked');
    // A brand-new key after the revocation is a first use again (a rotated server).
    expect(decideHostKey(trusted, key('N'), revoked)).toBe('unknown');

    // No prompt can offer it, and neither the prompt, trust-key nor pre-trust accepts it.
    await store.recordPending(at, a);
    expect((await store.list(at)).filter((k) => k.status === 'pending')).toEqual([]);
    expect(await store.trustPending(at, a.fingerprint, userId)).toBe(false);
    const pasted = { fingerprint: a.fingerprint, keyType: a.type, decidedBy: userId };
    expect(await store.trust(at, { ...pasted, allowPreTrust: true })).toBe('revoked');
    expect(await store.trust(at, { ...pasted, allowPreTrust: false })).toBe('no_match');
    expect(trustedRows()).toEqual([]);

    // A pending row of it left over from before the fix cannot be promoted either.
    db.$client
      .prepare(
        `INSERT INTO known_host_keys (id, user_id, hostname, port, key_type, public_key_b64,
           fingerprint_sha256, status, first_seen_at)
         VALUES ('stale', ?, '127.0.0.1', 22, ?, ?, ?, 'pending', ?)`,
      )
      .run(userId, a.type, a.publicKeyB64, a.fingerprint, 1_000_000);
    expect(await store.trustPending(at, a.fingerprint, userId)).toBe(false);
    expect(trustedRows()).toEqual([]);

    // replace-key (address confirmed by the route) is the explicit way back.
    await store.replace(at, a.type, a.fingerprint, userId);
    expect(trustedRows()).toEqual([{ fp: a.fingerprint }]);
    const after = await store.trusted(at);
    expect(decideHostKey(after, a, await store.revoked(at))).toBe('trusted');
    expect(await store.trust(at, { ...pasted, allowPreTrust: true })).toBe('already_trusted');

    store.recordRevokedPresented(at, a, userId, { source: 'host_test' });
    await writer.flush();
    expect(auditTypes(db)).toContain('host_key.revoked_presented');
    expect(auditTypes(db).filter((t) => t === 'host_key.pending')).toHaveLength(1);
  });

  it('audits a revoked key seen by a session handshake as host_key.revoked_presented', async () => {
    const { db, writer, store, userId } = setup();
    const presented = key('R');
    const inner: TransportFactory = {
      async create(_record, hooks) {
        hooks.onHostKey(presented, 'revoked');
        return {} as Transport;
      },
    };
    const decisions: string[] = [];
    await auditHostKeyMismatches(inner, store).create(makeRecord({ id: 's1', userId }), {
      onHostKey: (_key, decision) => decisions.push(decision),
      onKeyboardInteractive: async () => null,
    });
    await writer.flush();
    expect(decisions).toEqual(['revoked']);
    expect(auditTypes(db)).toEqual(['host_key.revoked_presented']);
  });
});

describe('SqliteHostKeyStore: one decision per user and address (D-29)', () => {
  it("a decision through one server applies to the same user's other servers with that address, never to another user's", async () => {
    const { db, store, userId, at } = setup();
    const other = insertUser(db);
    const sameAddress = insertServer(db, userId, { name: 'as root', username: 'root' });
    const othersServer = insertServer(db, other);
    const a = key('A');
    await store.recordPending(at, a);
    expect(await store.trustPending(at, a.fingerprint, userId)).toBe(true);

    // The same user's other server at 127.0.0.1:22 sees the key trusted, the prompt is gone.
    const viaSecond: HostKeyTarget = { ...at, serverId: sameAddress };
    expect((await store.trusted(viaSecond)).get(a.type)).toEqual(a);
    expect(await store.list(viaSecond)).toMatchObject([{ status: 'trusted' }]);
    // And a revoke through it is the revoke of the address.
    expect(await store.revoke(viaSecond, a.type, userId)).toBe(true);
    expect((await store.trusted(at)).size).toBe(0);
    expect(await store.revoked(at)).toEqual(new Set([a.fingerprint]));

    // Another user at the very same address decides alone: nothing trusted nor revoked there.
    const theirs: HostKeyTarget = { ...at, userId: other, serverId: othersServer };
    expect((await store.trusted(theirs)).size).toBe(0);
    expect((await store.revoked(theirs)).size).toBe(0);
    expect(await store.list(theirs)).toEqual([]);
    // Their first use records their own pending row and trusts the key for them only.
    await store.recordPending(theirs, a);
    expect(await store.trustPending(theirs, a.fingerprint, other)).toBe(true);
    expect((await store.trusted(theirs)).get(a.type)?.fingerprint).toBe(a.fingerprint);
    expect((await store.trusted(at)).size).toBe(0);
    expect(await store.revoked(at)).toEqual(new Set([a.fingerprint]));
  });

  it('`DB.Internal` and `db.internal` are one address; the same IP on another port is another', async () => {
    const { store, userId } = setup();
    const a = key('A');
    const upper: HostKeyTarget = { userId, hostname: ' DB.Internal ', port: 22, serverId: null };
    const lower: HostKeyTarget = { userId, hostname: 'db.internal', port: 22, serverId: null };
    expect(
      await store.trust(upper, {
        fingerprint: a.fingerprint,
        keyType: a.type,
        decidedBy: userId,
        allowPreTrust: true,
      }),
    ).toBe('trusted');
    expect((await store.trusted(lower)).get(a.type)?.fingerprint).toBe(a.fingerprint);
    expect(
      await store.trust(lower, {
        fingerprint: a.fingerprint,
        keyType: a.type,
        decidedBy: userId,
        allowPreTrust: true,
      }),
    ).toBe('already_trusted');
    expect(await store.list(upper)).toHaveLength(1);
    // IPv6 with or without brackets is one address too.
    const v6 = { userId, port: 22, serverId: null };
    await store.recordPending({ ...v6, hostname: '[FE80::1]' }, a);
    expect(await store.list({ ...v6, hostname: 'fe80::1' })).toMatchObject([{ status: 'pending' }]);

    const ip: HostKeyTarget = { userId, hostname: '10.0.0.12', port: 22, serverId: null };
    const otherPort: HostKeyTarget = { ...ip, port: 2222 };
    await store.trust(ip, {
      fingerprint: a.fingerprint,
      keyType: a.type,
      decidedBy: userId,
      allowPreTrust: true,
    });
    expect((await store.trusted(ip)).size).toBe(1);
    expect((await store.trusted(otherPort)).size).toBe(0);
    // A different key on the other port is a separate first use, not a conflict.
    const b = key('B');
    expect(
      await store.trust(otherPort, {
        fingerprint: b.fingerprint,
        keyType: b.type,
        decidedBy: userId,
        allowPreTrust: true,
      }),
    ).toBe('trusted');
  });

  it('decisions outlive the servers: deleting a server row leaves known_host_keys untouched', async () => {
    const { db, store, userId, serverId, at } = setup();
    const a = key('A');
    const b = key('B', 'ecdsa-sha2-nistp256');
    await store.trust(at, {
      fingerprint: a.fingerprint,
      keyType: a.type,
      decidedBy: userId,
      allowPreTrust: true,
    });
    await store.revoke(at, a.type, userId);
    await store.recordPending(at, b);
    const rows = () =>
      db.$client
        .prepare('SELECT id, key_type, fingerprint_sha256, status FROM known_host_keys ORDER BY id')
        .all();
    const before = rows();
    expect(before).toHaveLength(2);

    db.$client.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    expect(rows()).toEqual(before);

    // The same address added again as a new server: the revoked key is still refused.
    const readded: HostKeyTarget = { ...at, serverId: insertServer(db, userId) };
    expect(await store.revoked(readded)).toEqual(new Set([a.fingerprint]));
    expect(
      await store.trust(readded, {
        fingerprint: a.fingerprint,
        keyType: a.type,
        decidedBy: userId,
        allowPreTrust: true,
      }),
    ).toBe('revoked');
    await store.recordPending(readded, a);
    expect(rows()).toEqual(before);
  });
});

describe('SqliteHostKeyStore: a key the address already trusts', () => {
  it('is `already_trusted` for an in-flow decision without a pending row, never `no_match`', async () => {
    const { db, store, userId, at } = setup();
    const a = key('A');
    const inFlow = { fingerprint: a.fingerprint, decidedBy: userId, allowPreTrust: false };
    await store.recordPending(at, a);
    expect(await store.trust(at, inFlow)).toBe('trusted');
    // Its pending row was promoted: a second decision for it trusts nothing new.
    expect(await store.trust(at, inFlow)).toBe('already_trusted');
    expect(await store.trustPending({ ...at, serverId: null }, a.fingerprint, userId)).toBe(true);
    // Only for that exact key: another fingerprint, or a type it is not trusted as, has no match.
    expect(await store.trust(at, { ...inFlow, fingerprint: key('B').fingerprint })).toBe(
      'no_match',
    );
    expect(await store.trust(at, { ...inFlow, keyType: 'ecdsa-sha2-nistp256' })).toBe('no_match');
    // A pasted pre-trust fingerprint is answered the same way.
    const pasted = key('P', 'ecdsa-sha2-nistp256');
    await store.trust(at, {
      fingerprint: pasted.fingerprint,
      keyType: pasted.type,
      decidedBy: userId,
      allowPreTrust: true,
    });
    expect(await store.trustPending(at, pasted.fingerprint, userId)).toBe(true);
    expect(auditTypes(db)).toEqual(['host_key.pending', 'host_key.trust', 'host_key.trust']);
  });

  it('two servers at one address awaiting the same key: accept on one, then the other, never "expired"', async () => {
    const { db, writer, store, userId, serverId } = setup();
    const asRoot = insertServer(db, userId, { name: 'as root', username: 'root' });
    const address = { userId, hostname: '127.0.0.1', port: 22 };
    // Every connect presents TEST_KEY, decided against the store like SshTransportFactory does.
    const behavior = (): FakeTransportBehavior => ({
      connect: async (hooks) => {
        const decision = decideHostKey(
          await store.trusted(address),
          TEST_KEY,
          await store.revoked(address),
        );
        hooks.onHostKey({ ...TEST_KEY }, decision);
        if (decision !== 'trusted') {
          throw new TermavoxError(ErrorCode.HostKeyRejected, 'unknown host key', {
            pending: { ...TEST_KEY },
          });
        }
      },
    });
    const h = harness({ behavior });
    const session = (id: string, server: string) =>
      h.runtime({
        hostKeys: store,
        record: h.store.add(makeRecord({ id, userId, serverId: server })),
      });
    const first = session('s-first', serverId);
    const second = session('s-second', asRoot);
    await first.start();
    await second.start();
    expect([first.state, second.state]).toEqual(['awaiting_host_key', 'awaiting_host_key']);
    expect(await store.list(address)).toMatchObject([{ status: 'pending' }]); // one row for both

    expect(await first.hostKeyDecision(TEST_KEY.fingerprint, true, userId)).toBe(true);
    await until(() => first.state === 'ready');
    // The second prompt is still up; its pending row is gone, the key trusted for the address.
    expect(second.state).toBe('awaiting_host_key');
    expect(await second.hostKeyDecision(TEST_KEY.fingerprint, true, userId)).toBe(true);
    await until(() => second.state === 'ready');

    const types = h.store.events.map((e) => e.type);
    expect(types).not.toContain('host_key_expired');
    expect(types.filter((t) => t === 'host_key_trusted')).toHaveLength(2);
    expect(await store.list(address)).toMatchObject([{ status: 'trusted' }]);
    await writer.flush();
    expect(auditTypes(db)).toEqual(['host_key.pending', 'host_key.trust']); // trusted once
    await first.shutdown();
    await second.shutdown();
  });
});
