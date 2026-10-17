import { randomBytes } from 'node:crypto';
import type { SessionSummary } from '@termdock/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SessionRecord, sessionHostKeyTarget } from '../../src/core/types.ts';
import {
  bearerMatches,
  InternalApi,
  MAX_BODY_BYTES,
  type SessionControl,
  tokenDigest,
} from '../../src/internal-api/server.ts';
import { SqliteOwnership } from '../../src/store/access.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import { SqliteHostKeyStore } from '../../src/store/host-key-store.ts';
import { SqliteSessionStore } from '../../src/store/session-store.ts';
import { TargetPolicy } from '../../src/transport/ssh/index.ts';
import { CredentialService, VaultCredentialProvider } from '../../src/vault/credentials.ts';
import { insertServer, insertUser, type TempDb, tempDb, testVault } from '../store/fixture.ts';

// Spy on the constant-time primitive the bearer check must use.
const crypto = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      crypto.calls++;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const TOKEN = randomBytes(32).toString('base64url');
const INSTALLATION_ID = '0190f2b1-7c3a-7d4e-8f00-123456789abc';

/** Registry stand-in: records creations and serves the stored summaries. */
class FakeRegistry implements SessionControl {
  readonly created: SessionRecord[] = [];
  readonly actions: string[] = [];
  readonly store: SqliteSessionStore;
  constructor(store: SqliteSessionStore) {
    this.store = store;
  }
  create(record: SessionRecord): void {
    this.created.push(record);
  }
  async terminate(id: string, user: string) {
    this.actions.push(`terminate ${id} ${user}`);
  }
  /** Like the registry: every non-ended session of the user, terminated as its owner. */
  async terminateAll(user: string) {
    const live = (await this.store.listForUser(user)).filter((s) => s.state !== 'ended');
    for (const session of live) await this.terminate(session.id, user);
    return live.length;
  }
  async retry(id: string, user: string) {
    this.actions.push(`retry ${id} ${user}`);
  }
  async stop(id: string, user: string) {
    this.actions.push(`stop ${id} ${user}`);
  }
  async remove(id: string, user: string) {
    this.actions.push(`remove ${id} ${user}`);
  }
  async removeEnded(user: string) {
    this.actions.push(`removeEnded ${user}`);
    return 2;
  }
  async reopen(id: string, user: string) {
    this.actions.push(`reopen ${id} ${user}`);
    return { sessionId: id };
  }
  async renamed(id: string, user: string, label: string) {
    this.actions.push(`renamed ${id} ${user} ${label}`);
  }
  listForUser(userId: string): Promise<SessionSummary[]> {
    return this.store.listForUser(userId);
  }
  host() {
    return undefined;
  }
  get size() {
    return this.created.length;
  }
}

let fixture: TempDb;
let api: InternalApi;
let base: string;
let registry: FakeRegistry;
let hostKeys: SqliteHostKeyStore;
let userA: string;
let userB: string;
let serverA: string;
let credentialA: string;

async function call(
  method: string,
  path: string,
  body?: unknown,
  auth: string | null = `Bearer ${TOKEN}`,
): Promise<{
  status: number;
  json: { code?: string; message?: string; [k: string]: unknown } | null;
}> {
  const res = await fetch(`${base}/internal/v1${path}`, {
    method,
    headers: {
      ...(auth !== null ? { authorization: auth } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  fixture = tempDb();
  const { db } = fixture;
  const writer = new BatchedWriter(db);
  const vault = testVault();
  const sessions = new SqliteSessionStore(db, writer);
  const credentials = new CredentialService({ db, writer, vault });
  registry = new FakeRegistry(sessions);
  hostKeys = new SqliteHostKeyStore(db, writer);
  api = new InternalApi({
    host: '127.0.0.1',
    port: 0,
    token: new TextEncoder().encode(TOKEN),
    db,
    sessions,
    hostKeys,
    credentials,
    credentialProvider: new VaultCredentialProvider({ db, writer, vault }),
    ownership: new SqliteOwnership(db),
    registry,
    connections: { revoke: () => 0 },
    enableLocalShell: false,
    targetPolicy: new TargetPolicy({ allowLocalTargets: false }),
    installationId: INSTALLATION_ID,
    version: 'test',
  });
  const address = await api.listen();
  base = `http://127.0.0.1:${address.port}`;
  userA = insertUser(db);
  userB = insertUser(db);
  ({ credentialId: credentialA } = await credentials.create({
    actingUserId: userA,
    kind: 'password',
    name: 'pw',
    password: 'secret-a',
  }));
  serverA = insertServer(db, userA, { name: 'alpha', credentialId: credentialA });
});

afterEach(async () => {
  await api.close();
  fixture.cleanup();
});

describe('internal API auth', () => {
  it('answers 401 to a missing or wrong bearer and compares in constant time', async () => {
    expect((await call('GET', '/health', undefined, null)).status).toBe(401);
    expect((await call('GET', '/health', undefined, `Bearer ${TOKEN}x`)).status).toBe(401);
    expect((await call('GET', '/health', undefined, `Basic ${TOKEN}`)).status).toBe(401);
    const denied = await call('POST', '/sessions', { actingUserId: userA }, 'Bearer nope');
    expect(denied).toEqual({
      status: 401,
      json: { code: 'UNAUTHENTICATED', message: 'missing or invalid bearer token' },
    });
    const ok = await call('GET', '/health');
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, sessions: 0, version: 'test' });

    crypto.calls = 0;
    const digest = tokenDigest(new TextEncoder().encode(TOKEN));
    expect(bearerMatches(`Bearer ${TOKEN}`, digest)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN.slice(1)}`, digest)).toBe(false);
    expect(bearerMatches(undefined, digest)).toBe(false); // malformed: same comparison path
    expect(crypto.calls).toBe(3);
  });

  it('validates bodies: 400 without echoing input, 413 above 64 KiB', async () => {
    const bad = await call('POST', '/credentials', '{"password": "leak-me"');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).not.toContain('leak-me');
    const invalid = await call('POST', '/credentials', {
      actingUserId: userA,
      kind: 'password',
      name: 'x',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json?.message).toContain('password');
    const huge = await call('POST', '/credentials', { pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect(huge.status).toBe(413);
    expect((await call('GET', '/nope')).status).toBe(404);
  });
});

describe('internal API ownership (foreign resources are 404, like missing ones)', () => {
  it('creates a session from the acting user’s server and rejects user B on A’s resources', async () => {
    const created = await call('POST', '/sessions', {
      actingUserId: userA,
      serverId: serverA,
      viewport: { cols: 100, rows: 30 },
    });
    expect(created.status).toBe(201);
    const sessionId = created.json?.sessionId as string;
    expect(registry.created[0]).toMatchObject({
      id: sessionId,
      userId: userA,
      serverId: serverA,
      label: 'alpha',
      target: {
        kind: 'ssh',
        hostname: '127.0.0.1',
        port: 22,
        username: 'td',
        credentialId: credentialA,
      },
      cols: 100,
      rows: 30,
      state: 'new',
    });

    // A's server through B, even with B's own credentials around: 404 like a missing one.
    const asB = { actingUserId: userB };
    const viewport = { cols: 80, rows: 24 };
    expect((await call('POST', '/sessions', { ...asB, serverId: serverA, viewport })).json).toEqual(
      { code: 'NOT_FOUND', message: 'server not found' },
    );
    expect(
      (await call('POST', '/sessions', { ...asB, serverId: 'missing', viewport })).status,
    ).toBe(404);
    expect((await call('POST', `/sessions/${sessionId}/terminate`, asB)).status).toBe(404);
    expect((await call('POST', `/sessions/${sessionId}/retry`, asB)).status).toBe(404);
    expect((await call('POST', `/sessions/${sessionId}/stop`, asB)).status).toBe(404);
    expect((await call('DELETE', `/sessions/${sessionId}`, asB)).status).toBe(404);
    expect((await call('POST', `/sessions/${sessionId}/reopen`, asB)).status).toBe(404);
    expect(
      (await call('PATCH', `/credentials/${credentialA}`, { ...asB, name: 'mine' })).status,
    ).toBe(404);
    expect((await call('DELETE', `/credentials/${credentialA}`, asB)).status).toBe(404);
    const keyBody = { ...asB, keyType: 'ssh-ed25519', fingerprint: `SHA256:${'B'.repeat(43)}` };
    expect((await call('POST', `/servers/${serverA}/trust-key`, keyBody)).status).toBe(404);
    expect(
      (
        await call('POST', `/servers/${serverA}/replace-key`, {
          ...keyBody,
          confirmHostname: '127.0.0.1',
        })
      ).status,
    ).toBe(404);
    expect(
      (await call('POST', `/servers/${serverA}/revoke-key`, { ...asB, keyType: 'ssh-ed25519' }))
        .status,
    ).toBe(404);
    expect((await call('POST', `/servers/${serverA}/test`, asB)).status).toBe(404);
    expect(registry.created).toHaveLength(1);
    expect((await call('GET', `/sessions?actingUserId=${userB}`)).json).toEqual({ sessions: [] });
    expect(registry.actions).toEqual([]);

    expect(
      (await call('POST', `/sessions/${sessionId}/stop`, { actingUserId: userA })).status,
    ).toBe(204);
    expect(
      (await call('POST', `/sessions/${sessionId}/terminate`, { actingUserId: userA })).status,
    ).toBe(204);
    expect((await call('DELETE', `/sessions/${sessionId}`, { actingUserId: userA })).status).toBe(
      204,
    );
    expect((await call('POST', '/sessions/remove-ended', { actingUserId: userA })).json).toEqual({
      removed: 2,
    });
    expect(registry.actions).toEqual([
      `stop ${sessionId} ${userA}`,
      `terminate ${sessionId} ${userA}`,
      `remove ${sessionId} ${userA}`,
      `removeEnded ${userA}`,
    ]);
    const listed = await call('GET', `/sessions?actingUserId=${userA}`);
    expect(listed.json?.sessions).toEqual([
      { sessionId, state: 'new', status: 'connecting', protection: null, attachments: 0 },
    ]);
    // Unknown or banned acting users are refused outright.
    expect(
      (await call('POST', `/sessions/${sessionId}/retry`, { actingUserId: 'ghost' })).status,
    ).toBe(403);
  });

  it('refuses to delete a credential referenced by a non-ended session (409)', async () => {
    const created = await call('POST', '/sessions', {
      actingUserId: userA,
      serverId: serverA,
      viewport: { cols: 80, rows: 24 },
    });
    const sessionId = created.json?.sessionId as string;
    const conflict = await call('DELETE', `/credentials/${credentialA}`, { actingUserId: userA });
    expect(conflict.status).toBe(409);
    expect(conflict.json?.code).toBe('CONFLICT');
    fixture.db.$client.prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(sessionId);
    expect(
      (await call('DELETE', `/credentials/${credentialA}`, { actingUserId: userA })).status,
    ).toBe(204);
    expect(
      (await call('DELETE', `/credentials/${credentialA}`, { actingUserId: userA })).status,
    ).toBe(404);
    // The server keeps existing without a credential (the FK sets it null): it prompts now.
    expect(
      fixture.db.$client.prepare('SELECT credential_id FROM servers WHERE id = ?').get(serverA),
    ).toEqual({ credential_id: null });
  });

  it('rejects local servers while direct mode is off and enforces the running-session cap', async () => {
    const { db } = fixture;
    const local = insertServer(db, userA, { kind: 'local' });
    const viewport = { cols: 80, rows: 24 };
    const rejected = await call('POST', '/sessions', {
      actingUserId: userA,
      serverId: local,
      viewport,
    });
    expect(rejected).toMatchObject({ status: 403, json: { code: 'LOCAL_SHELL_DISABLED' } });
    // A local server has no address, so no host keys and nothing to test.
    const keyBody = { actingUserId: userA, keyType: 'ssh-ed25519' };
    expect(
      await call('POST', `/servers/${local}/trust-key`, {
        ...keyBody,
        fingerprint: `SHA256:${'L'.repeat(43)}`,
      }),
    ).toMatchObject({ status: 400, json: { code: 'BAD_REQUEST' } });
    expect((await call('POST', `/servers/${local}/revoke-key`, keyBody)).status).toBe(400);
    expect((await call('POST', `/servers/${local}/test`, { actingUserId: userA })).status).toBe(
      400,
    );

    db.$client
      .prepare(
        "INSERT INTO instance_settings (key, value_json, updated_at) VALUES ('max_running_sessions_per_user', '1', 0)",
      )
      .run();
    const body = { actingUserId: userA, serverId: serverA, viewport };
    expect((await call('POST', '/sessions', body)).status).toBe(201);
    expect(await call('POST', '/sessions', body)).toMatchObject({
      status: 429,
      json: { code: 'RATE_LIMITED' },
    });
  });
});

describe('internal API session labels (D-28)', () => {
  const viewport = { cols: 80, rows: 24 };
  const labelOf = (sessionId: string) =>
    (
      fixture.db.$client.prepare('SELECT label FROM sessions WHERE id = ?').get(sessionId) as {
        label: string;
      }
    ).label;
  const renameAudits = () =>
    (
      fixture.db.$client
        .prepare(
          "SELECT actor_user_id, target_type, target_id, detail_json FROM audit_events WHERE type = 'session.rename' ORDER BY rowid",
        )
        .all() as Array<Record<string, string>>
    ).map((r) => ({ ...r, detail_json: JSON.parse(r.detail_json!) }));

  it('creates with a cleaned label, or with the server name when none is given', async () => {
    const create = async (extra: Record<string, unknown>) =>
      call('POST', '/sessions', { actingUserId: userA, serverId: serverA, viewport, ...extra });
    const plain = await create({});
    expect(plain.status).toBe(201);
    expect(labelOf(plain.json?.sessionId as string)).toBe('alpha');

    const dirty = await create({ label: '  \u202Edeploy\u200B \x1b[31mlogs\x07\uFEFF  ' });
    expect(dirty.status).toBe(201);
    const sessionId = dirty.json?.sessionId as string;
    expect(labelOf(sessionId)).toBe('deploy [31mlogs');
    expect(registry.created.at(-1)).toMatchObject({ id: sessionId, label: 'deploy [31mlogs' });

    // Same limits as a rename: nothing left after cleaning, or more than 120 characters.
    for (const label of ['', '   ', '\u200B\u2066\x07', 'x'.repeat(121)]) {
      expect(await create({ label })).toMatchObject({
        status: 400,
        json: { code: 'LABEL_INVALID' },
      });
    }
    expect(registry.created).toHaveLength(2);
  });

  it('renames in any state for the owner only, cleaning, auditing and publishing the label', async () => {
    const created = await call('POST', '/sessions', {
      actingUserId: userA,
      serverId: serverA,
      viewport,
    });
    const sessionId = created.json?.sessionId as string;
    const rename = (label: unknown, actingUserId = userA) =>
      call('PATCH', `/sessions/${sessionId}`, { actingUserId, label });

    // Control, bidi and zero-width characters are dropped before the length check, then trimmed.
    const renamed = await rename(` \u202Ebuild\u200D box\x00\u2069 ${'\u200B'.repeat(200)}`);
    expect(renamed).toEqual({ status: 200, json: { sessionId, label: 'build box' } });
    expect(labelOf(sessionId)).toBe('build box');
    expect(registry.actions).toEqual([`renamed ${sessionId} ${userA} build box`]);
    expect(renameAudits()).toEqual([
      {
        actor_user_id: userA,
        target_type: 'session',
        target_id: sessionId,
        detail_json: { previousLabel: 'alpha', label: 'build box' },
      },
    ]);
    // The same label again: nothing to write, audit or publish.
    expect((await rename('build box')).status).toBe(200);
    expect(renameAudits()).toHaveLength(1);
    expect(registry.actions).toHaveLength(1);

    // Empty, whitespace-only, invisible-only and over-long labels: 400 LABEL_INVALID, unchanged.
    for (const label of ['', '  \t ', '\u200B\u202E\uFEFF', 'y'.repeat(121)]) {
      expect(await rename(label)).toMatchObject({ status: 400, json: { code: 'LABEL_INVALID' } });
    }
    expect(await rename('z'.repeat(120))).toMatchObject({ status: 200 });
    expect((await rename(42)).json?.code).toBe('BAD_REQUEST');

    // Another user: 404 like a missing session, nothing changed; unknown actors are refused.
    expect(await rename('mine', userB)).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
    expect(
      (await call('PATCH', '/sessions/missing', { actingUserId: userA, label: 'x' })).status,
    ).toBe(404);
    expect((await rename('ghost', 'ghost')).status).toBe(403);
    expect(labelOf(sessionId)).toBe('z'.repeat(120));

    // Ended sessions keep their history and can still be renamed: it is only a name.
    fixture.db.$client.prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(sessionId);
    expect(await rename('archived')).toEqual({
      status: 200,
      json: { sessionId, label: 'archived' },
    });
    expect(renameAudits().map((a) => a.detail_json)).toEqual([
      { previousLabel: 'alpha', label: 'build box' },
      { previousLabel: 'build box', label: 'z'.repeat(120) },
      { previousLabel: 'z'.repeat(120), label: 'archived' },
    ]);
  });
});

describe('internal API admin: terminate a user’s sessions', () => {
  it('lets only an admin terminate every non-ended session of the target user', async () => {
    const viewport = { cols: 80, rows: 24 };
    const create = async () =>
      (await call('POST', '/sessions', { actingUserId: userA, serverId: serverA, viewport })).json
        ?.sessionId as string;
    const live = await create();
    const ended = await create();
    fixture.db.$client.prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(ended);
    const path = `/users/${userA}/terminate-sessions`;

    // A regular user (even acting on their own sessions) and an unknown actor are refused.
    expect(await call('POST', path, { actingUserId: userB })).toMatchObject({
      status: 403,
      json: { code: 'FORBIDDEN' },
    });
    expect((await call('POST', path, { actingUserId: userA })).status).toBe(403);
    expect((await call('POST', path, { actingUserId: 'ghost' })).status).toBe(403);
    const bannedAdmin = insertUser(fixture.db, { role: 'admin', banned: true });
    expect((await call('POST', path, { actingUserId: bannedAdmin })).status).toBe(403);
    expect(registry.actions).toEqual([]);

    const admin = insertUser(fixture.db, { role: 'user,admin' });
    expect(
      (await call('POST', '/users/nobody/terminate-sessions', { actingUserId: admin })).status,
    ).toBe(404);
    const done = await call('POST', path, { actingUserId: admin });
    expect(done).toEqual({ status: 200, json: { terminated: 1 } });
    // Terminated as the owner, so the registry's ownership check applies; ended ones are skipped.
    expect(registry.actions).toEqual([`terminate ${live} ${userA}`]);
  });
});

describe('internal API server tests and host keys', () => {
  const fp = (c: string) => `SHA256:${c.repeat(43)}`;
  const keyRows = () =>
    fixture.db.$client
      .prepare(
        'SELECT user_id, hostname, port, key_type, fingerprint_sha256, status FROM known_host_keys ORDER BY rowid',
      )
      .all();
  const hostKeyAudits = () =>
    (
      fixture.db.$client
        .prepare(
          "SELECT type, target_type, target_id, detail_json FROM audit_events WHERE type LIKE 'host_key.%' ORDER BY rowid",
        )
        .all() as Array<{
        type: string;
        target_type: string;
        target_id: string | null;
        detail_json: string;
      }>
    ).map((r) => ({ ...r, detail_json: JSON.parse(r.detail_json) as Record<string, unknown> }));
  const trustKey = (serverId: string, fingerprint: string, actingUserId = userA) =>
    call('POST', `/servers/${serverId}/trust-key`, {
      actingUserId,
      keyType: 'ssh-ed25519',
      fingerprint,
    });
  const revokeKey = (serverId: string, actingUserId = userA) =>
    call('POST', `/servers/${serverId}/revoke-key`, { actingUserId, keyType: 'ssh-ed25519' });
  const replaceKey = (serverId: string, fingerprint: string, confirmHostname: string) =>
    call('POST', `/servers/${serverId}/replace-key`, {
      actingUserId: userA,
      keyType: 'ssh-ed25519',
      fingerprint,
      confirmHostname,
    });

  it('reports a refused target as a result and allows 10 server tests per user and minute (L4)', async () => {
    // serverA points at 127.0.0.1: refused by the default target policy, without connecting.
    for (let i = 0; i < 10; i++) {
      expect(await call('POST', `/servers/${serverA}/test`, { actingUserId: userA })).toEqual({
        status: 200,
        json: { reachable: false, error: 'TARGET_NOT_ALLOWED', hostKey: null, probe: null },
      });
    }
    expect(await call('POST', `/servers/${serverA}/test`, { actingUserId: userA })).toMatchObject({
      status: 429,
      json: { code: 'RATE_LIMITED' },
    });
    // Per user: another user still has their own budget.
    const serverB = insertServer(fixture.db, userB);
    expect((await call('POST', `/servers/${serverB}/test`, { actingUserId: userB })).status).toBe(
      200,
    );
  });

  it('refuses to trust a revoked key again; replace-key with the confirmed hostname does (M2)', async () => {
    const fingerprint = fp('R');
    expect((await trustKey(serverA, fingerprint)).status).toBe(204);
    expect((await revokeKey(serverA)).status).toBe(204);
    const refused = await trustKey(serverA, fingerprint);
    expect(refused).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
    expect(refused.json?.message).toMatch(/revoked/);
    expect((await replaceKey(serverA, fingerprint, '127.0.0.1')).status).toBe(204);
    expect((await trustKey(serverA, fingerprint)).status).toBe(204); // idempotent
  });

  it("a decision through one server applies to the user's other servers with that address, not to another user's", async () => {
    const { db } = fixture;
    // Same machine, same address, another login: a second server of user A.
    const asRoot = insertServer(db, userA, { name: 'alpha as root', username: 'root' });
    const serverB = insertServer(db, userB, { name: 'alpha' });
    const address = { userId: userA, hostname: '127.0.0.1', port: 22 };

    expect((await trustKey(serverA, fp('A'))).status).toBe(204);
    // Through the other server: the same decision, already made.
    expect((await trustKey(asRoot, fp('A'))).status).toBe(204);
    expect(await trustKey(asRoot, fp('C'))).toMatchObject({
      status: 409,
      json: { code: 'CONFLICT' },
    });
    expect(keyRows()).toEqual([
      {
        user_id: userA,
        hostname: '127.0.0.1',
        port: 22,
        key_type: 'ssh-ed25519',
        fingerprint_sha256: fp('A'),
        status: 'trusted',
      },
    ]);
    // A session opened from that other server checks against it at connect time.
    const created = await call('POST', '/sessions', {
      actingUserId: userA,
      serverId: asRoot,
      viewport: { cols: 80, rows: 24 },
    });
    expect(created.status).toBe(201);
    const record = registry.created.at(-1)!;
    expect(record).toMatchObject({ serverId: asRoot, target: { username: 'root' } });
    expect((await hostKeys.trusted(sessionHostKeyTarget(record))).get('ssh-ed25519')).toMatchObject(
      { fingerprint: fp('A') },
    );

    // User B at the very same address decides alone: no conflict, and A's decision is untouched.
    expect((await hostKeys.trusted({ ...address, userId: userB })).size).toBe(0);
    expect((await trustKey(serverB, fp('B'), userB)).status).toBe(204);
    expect((await hostKeys.trusted(address)).get('ssh-ed25519')?.fingerprint).toBe(fp('A'));
    expect((await revokeKey(serverB, userB)).status).toBe(204);
    expect((await hostKeys.trusted(address)).size).toBe(1);

    // A revoke through the other server is the revoke of the address, for both of A's servers.
    expect((await revokeKey(asRoot)).status).toBe(204);
    expect((await revokeKey(serverA)).status).toBe(404);
    expect(await trustKey(serverA, fp('A'))).toMatchObject({ status: 409 });

    // Each audit row names the server the route was called with, and the address.
    expect(
      hostKeyAudits().map((a) => [a.type, a.target_type, a.target_id, a.detail_json.hostname]),
    ).toEqual([
      ['host_key.trust', 'server', serverA, '127.0.0.1'],
      ['host_key.trust', 'server', serverB, '127.0.0.1'],
      ['host_key.revoke', 'server', serverB, '127.0.0.1'],
      ['host_key.revoke', 'server', asRoot, '127.0.0.1'],
    ]);
  });

  it('`DB.Internal` and `db.internal` share one trust decision; the same IP on another port does not', async () => {
    const { db } = fixture;
    // Web stores hostnames normalized; the daemon normalizes again where they enter host keys.
    const upper = insertServer(db, userA, { hostname: 'DB.Internal' });
    const lower = insertServer(db, userA, { hostname: 'db.internal' });
    const ip = insertServer(db, userA, { hostname: '10.0.0.12', port: 22 });
    const ipOtherPort = insertServer(db, userA, { hostname: '10.0.0.12', port: 2222 });

    expect((await trustKey(upper, fp('X'))).status).toBe(204);
    expect((await trustKey(lower, fp('X'))).status).toBe(204); // already trusted
    expect((await trustKey(lower, fp('Y'))).status).toBe(409); // the one decision conflicts
    // Replacing through either confirms with the address in any spelling.
    expect((await replaceKey(lower, fp('Y'), 'DB.INTERNAL')).status).toBe(204);
    expect(
      (await hostKeys.trusted({ userId: userA, hostname: 'DB.Internal', port: 22 })).get(
        'ssh-ed25519',
      )?.fingerprint,
    ).toBe(fp('Y'));

    expect((await trustKey(ip, fp('X'))).status).toBe(204);
    expect((await trustKey(ipOtherPort, fp('Y'))).status).toBe(204); // another address
    expect((await revokeKey(ipOtherPort)).status).toBe(204);
    expect((await hostKeys.trusted({ userId: userA, hostname: '10.0.0.12', port: 22 })).size).toBe(
      1,
    );
    expect(
      keyRows()
        .map((r) => `${(r as { hostname: string }).hostname}:${(r as { port: number }).port}`)
        .sort(),
    ).toEqual(['10.0.0.12:22', '10.0.0.12:2222', 'db.internal:22', 'db.internal:22']);
  });

  it('a revoked key stays revoked after its server is deleted and added again', async () => {
    const { db } = fixture;
    const first = insertServer(db, userA, { name: 'gateway', hostname: '10.0.0.5' });
    expect((await trustKey(first, fp('K'))).status).toBe(204);
    expect((await revokeKey(first)).status).toBe(204);
    const before = keyRows();

    db.$client.prepare('DELETE FROM servers WHERE id = ?').run(first);
    expect(keyRows()).toEqual(before);
    expect((await trustKey(first, fp('K'))).status).toBe(404); // the server is gone

    const again = insertServer(db, userA, { name: 'gateway', hostname: '10.0.0.5' });
    const refused = await trustKey(again, fp('K'));
    expect(refused).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
    expect(refused.json?.message).toMatch(/revoked/);
    expect(await hostKeys.revoked({ userId: userA, hostname: '10.0.0.5', port: 22 })).toEqual(
      new Set([fp('K')]),
    );
    expect(keyRows()).toEqual(before);
  });

  it('replace-key with a wrong confirmHostname is 400 and changes nothing', async () => {
    expect((await trustKey(serverA, fp('A'))).status).toBe(204);
    const rows = keyRows();
    const audits = hostKeyAudits();
    // The server's name (the old confirmation), another address, or a port suffix: all refused.
    for (const confirmHostname of ['alpha', '127.0.0.2', '127.0.0.1:22']) {
      expect(await replaceKey(serverA, fp('B'), confirmHostname)).toMatchObject({
        status: 400,
        json: { code: 'BAD_REQUEST' },
      });
    }
    expect((await replaceKey(serverA, fp('B'), '')).status).toBe(400); // schema: min 1
    expect(keyRows()).toEqual(rows);
    expect(hostKeyAudits()).toEqual(audits);
    // The stored hostname, typed with stray spaces, confirms.
    expect((await replaceKey(serverA, fp('B'), ' 127.0.0.1 ')).status).toBe(204);
    expect((await hostKeys.trusted({ userId: userA, hostname: '127.0.0.1', port: 22 })).size).toBe(
      1,
    );
  });
});
