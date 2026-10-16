import { randomBytes } from 'node:crypto';
import type { SessionSummary } from '@termdock/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/core/types.ts';
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
import {
  insertHost,
  insertProfile,
  insertUser,
  type TempDb,
  tempDb,
  testVault,
} from '../store/fixture.ts';

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
  async retry(id: string, user: string) {
    this.actions.push(`retry ${id} ${user}`);
  }
  async reopen(id: string, user: string) {
    this.actions.push(`reopen ${id} ${user}`);
    return { sessionId: id };
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
let userA: string;
let userB: string;
let hostA: string;
let profileA: string;
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
  api = new InternalApi({
    host: '127.0.0.1',
    port: 0,
    token: new TextEncoder().encode(TOKEN),
    db,
    sessions,
    hostKeys: new SqliteHostKeyStore(db, writer),
    credentials,
    credentialProvider: new VaultCredentialProvider({ db, writer, vault }),
    ownership: new SqliteOwnership(db),
    registry,
    connections: { revoke: () => 0 },
    enableLocalShell: false,
    targetPolicy: new TargetPolicy({ allowLocalTargets: false }),
    version: 'test',
  });
  const address = await api.listen();
  base = `http://127.0.0.1:${address.port}`;
  userA = insertUser(db);
  userB = insertUser(db);
  hostA = insertHost(db, userA, { name: 'alpha' });
  ({ credentialId: credentialA } = await credentials.create({
    actingUserId: userA,
    kind: 'password',
    name: 'pw',
    password: 'secret-a',
  }));
  profileA = insertProfile(db, userA, hostA, credentialA);
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
  it('creates a session from the acting user’s profile and rejects user B on A’s resources', async () => {
    const created = await call('POST', '/sessions', {
      actingUserId: userA,
      profileId: profileA,
      viewport: { cols: 100, rows: 30 },
    });
    expect(created.status).toBe(201);
    const sessionId = created.json?.sessionId as string;
    expect(registry.created[0]).toMatchObject({
      id: sessionId,
      userId: userA,
      target: { kind: 'ssh', hostId: hostA, username: 'td', credentialId: credentialA },
      cols: 100,
      rows: 30,
      state: 'new',
    });

    const asB = { actingUserId: userB };
    const viewport = { cols: 80, rows: 24 };
    expect(
      (await call('POST', '/sessions', { ...asB, profileId: profileA, viewport })).status,
    ).toBe(404);
    expect((await call('POST', `/sessions/${sessionId}/terminate`, asB)).status).toBe(404);
    expect((await call('POST', `/sessions/${sessionId}/retry`, asB)).status).toBe(404);
    expect((await call('POST', `/sessions/${sessionId}/reopen`, asB)).status).toBe(404);
    expect(
      (await call('PATCH', `/credentials/${credentialA}`, { ...asB, name: 'mine' })).status,
    ).toBe(404);
    expect((await call('DELETE', `/credentials/${credentialA}`, asB)).status).toBe(404);
    expect(
      (await call('POST', `/hosts/${hostA}/revoke-key`, { ...asB, keyType: 'ssh-ed25519' })).status,
    ).toBe(404);
    expect((await call('POST', `/hosts/${hostA}/test`, asB)).status).toBe(404);
    expect((await call('GET', `/sessions?actingUserId=${userB}`)).json).toEqual({ sessions: [] });
    expect(registry.actions).toEqual([]);

    expect(
      (await call('POST', `/sessions/${sessionId}/terminate`, { actingUserId: userA })).status,
    ).toBe(204);
    expect(registry.actions).toEqual([`terminate ${sessionId} ${userA}`]);
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
      profileId: profileA,
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
  });

  it('rejects local hosts while direct mode is off and enforces the running-session cap', async () => {
    const { db } = fixture;
    const local = insertProfile(db, userA, insertHost(db, userA, { kind: 'local' }), null);
    const viewport = { cols: 80, rows: 24 };
    const rejected = await call('POST', '/sessions', {
      actingUserId: userA,
      profileId: local,
      viewport,
    });
    expect(rejected).toMatchObject({ status: 403, json: { code: 'LOCAL_SHELL_DISABLED' } });

    db.$client
      .prepare(
        "INSERT INTO instance_settings (key, value_json, updated_at) VALUES ('max_running_sessions_per_user', '1', 0)",
      )
      .run();
    const body = { actingUserId: userA, profileId: profileA, viewport };
    expect((await call('POST', '/sessions', body)).status).toBe(201);
    expect(await call('POST', '/sessions', body)).toMatchObject({
      status: 429,
      json: { code: 'RATE_LIMITED' },
    });
  });
});

describe('internal API admin: terminate a user’s sessions', () => {
  it('lets only an admin terminate every non-ended session of the target user', async () => {
    const viewport = { cols: 80, rows: 24 };
    const create = async () =>
      (await call('POST', '/sessions', { actingUserId: userA, profileId: profileA, viewport })).json
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

describe('internal API host tests and host keys', () => {
  it('reports a refused target as a result and allows 10 host tests per user and minute (L4)', async () => {
    // hostA points at 127.0.0.1: refused by the default target policy, without connecting.
    for (let i = 0; i < 10; i++) {
      expect(await call('POST', `/hosts/${hostA}/test`, { actingUserId: userA })).toEqual({
        status: 200,
        json: { reachable: false, error: 'TARGET_NOT_ALLOWED', hostKey: null, probe: null },
      });
    }
    expect(await call('POST', `/hosts/${hostA}/test`, { actingUserId: userA })).toMatchObject({
      status: 429,
      json: { code: 'RATE_LIMITED' },
    });
    // Per user: another user still has their own budget.
    const hostB = insertHost(fixture.db, userB);
    expect((await call('POST', `/hosts/${hostB}/test`, { actingUserId: userB })).status).toBe(200);
  });

  it('refuses to trust a revoked key again; replace-key with the confirmed name does (M2)', async () => {
    const fingerprint = `SHA256:${'R'.repeat(43)}`;
    const body = { actingUserId: userA, keyType: 'ssh-ed25519', fingerprint };
    expect((await call('POST', `/hosts/${hostA}/trust-key`, body)).status).toBe(204);
    const revoke = { actingUserId: userA, keyType: 'ssh-ed25519' };
    expect((await call('POST', `/hosts/${hostA}/revoke-key`, revoke)).status).toBe(204);
    const refused = await call('POST', `/hosts/${hostA}/trust-key`, body);
    expect(refused).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
    expect(refused.json?.message).toMatch(/revoked/);
    const replace = { ...body, confirmHostName: 'alpha' };
    expect((await call('POST', `/hosts/${hostA}/replace-key`, replace)).status).toBe(204);
    expect((await call('POST', `/hosts/${hostA}/trust-key`, body)).status).toBe(204); // idempotent
  });
});
