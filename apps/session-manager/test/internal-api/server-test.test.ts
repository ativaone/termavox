import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TermdockDb } from '@termdock/db';
import { ServerTestResponse } from '@termdock/protocol';
import ssh2 from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialProvider, HostKeyTarget } from '../../src/core/types.ts';
import { testServer } from '../../src/internal-api/server-test.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import { SqliteHostKeyStore } from '../../src/store/host-key-store.ts';
import { parsePublicKeyLine, TargetPolicy } from '../../src/transport/ssh/index.ts';
import { insertServer, insertUser, type TempDb, tempDb } from '../store/fixture.ts';

const KEYS = fileURLToPath(new URL('../../../../test/sshd/keys/', import.meta.url));
const HOST_PRIVATE_KEY = readFileSync(`${KEYS}ssh_host_ed25519_key`);
const HOST_KEY = parsePublicKeyLine(readFileSync(`${KEYS}ssh_host_ed25519_key.pub`, 'utf8'));
const OTHER_FINGERPRINT = `SHA256:${'Q'.repeat(43)}`;

interface AuthAttempt {
  username: string;
  method: string;
}

/**
 * An in-process SSH server presenting the committed test host key; nobody may log in. Every
 * authentication attempt is recorded.
 */
async function startServer(): Promise<{
  port: number;
  attempts: AuthAttempt[];
  close(): Promise<void>;
}> {
  const clients = new Set<ssh2.Connection>();
  const attempts: AuthAttempt[] = [];
  const server = new ssh2.Server({ hostKeys: [HOST_PRIVATE_KEY] }, (client) => {
    clients.add(client);
    client.on('authentication', (ctx) => {
      attempts.push({ username: ctx.username, method: ctx.method });
      ctx.reject();
    });
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    attempts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        server.close(() => resolve());
      }),
  };
}

let fixture: TempDb | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  fixture?.cleanup();
  stop = undefined;
  fixture = undefined;
});

/** A credentials row for the FK; the fake provider below hands out the secret. */
function insertCredential(db: TermdockDb, userId: string): string {
  const id = `cred-${userId}`;
  db.$client
    .prepare(
      `INSERT INTO credentials (id, user_id, name, kind, ciphertext, nonce, key_version, created_at)
       VALUES (?, ?, 'pw', 'password', x'00', x'00', 1, 0)`,
    )
    .run(id, userId);
  return id;
}

async function setup() {
  fixture = tempDb();
  const { db } = fixture;
  const server = await startServer();
  stop = server.close;
  const hostKeys = new SqliteHostKeyStore(db, new BatchedWriter(db));
  const userId = insertUser(db);
  const fetched: string[] = [];
  const deps = {
    db,
    hostKeys,
    credentials: {
      get: async (credentialId) => {
        fetched.push(credentialId);
        return { kind: 'password', password: 'not-the-password' };
      },
    } satisfies CredentialProvider,
    // The test server listens on loopback.
    targetPolicy: new TargetPolicy({ allowLocalTargets: true, localAddresses: () => [] }),
    readyTimeoutMs: 5_000,
  };
  const run = async (serverId: string, actingUserId = userId) =>
    ServerTestResponse.parse(await testServer(deps, { actingUserId, serverId }));
  const at = (serverId: string | null, user = userId): HostKeyTarget => ({
    userId: user,
    hostname: '127.0.0.1',
    port: server.port,
    serverId,
  });
  return { db, hostKeys, userId, port: server.port, attempts: server.attempts, fetched, run, at };
}

describe('server test: a revoked key is reported as revoked, not as a plain mismatch', () => {
  it('flags `revoked: true` only when the presented key matches a revoked row', async () => {
    const { db, hostKeys, userId, port, run, at } = await setup();
    const serverId = insertServer(db, userId, { port });

    // Unknown key: recorded as pending for the address, nothing flagged.
    const first = await run(serverId);
    expect(first).toEqual({
      reachable: true,
      error: null,
      hostKey: { type: 'ssh-ed25519', fingerprint: HOST_KEY.fingerprint, trusted: false },
      probe: null,
    });
    expect(await hostKeys.list(at(serverId))).toMatchObject([{ status: 'pending' }]);

    // Trusted: still nothing flagged.
    const trusted = await hostKeys.trust(at(serverId), {
      fingerprint: HOST_KEY.fingerprint,
      decidedBy: userId,
      allowPreTrust: false,
    });
    expect(trusted).toBe('trusted');
    const ok = await run(serverId);
    expect(ok).toMatchObject({ reachable: true, error: null, hostKey: { trusted: true } });
    expect(ok).not.toHaveProperty('revoked');

    // The owner revokes that very key: the next test says so (and keeps the old error code).
    expect(await hostKeys.revoke(at(serverId), 'ssh-ed25519', userId)).toBe(true);
    const revoked = await run(serverId);
    expect(revoked).toEqual({
      reachable: true,
      error: 'HOST_KEY_MISMATCH',
      hostKey: { type: 'ssh-ed25519', fingerprint: HOST_KEY.fingerprint, trusted: false },
      probe: null,
      revoked: true,
    });
  });

  it('a different trusted key is a mismatch without the revoked flag', async () => {
    const { db, hostKeys, userId, port, run, at } = await setup();
    const serverId = insertServer(db, userId, { port });
    const pretrusted = await hostKeys.trust(at(serverId), {
      fingerprint: OTHER_FINGERPRINT,
      keyType: 'ssh-ed25519',
      decidedBy: userId,
      allowPreTrust: true,
    });
    expect(pretrusted).toBe('trusted');
    const result = await run(serverId);
    expect(result).toMatchObject({
      reachable: true,
      error: 'HOST_KEY_MISMATCH',
      hostKey: { fingerprint: HOST_KEY.fingerprint, trusted: false },
    });
    expect(result).not.toHaveProperty('revoked');
  });
});

describe('server test: signs in with the server’s own user name and credential', () => {
  it('a server without a credential stops after the host key: no login reaches the host', async () => {
    const { db, hostKeys, userId, port, attempts, fetched, run, at } = await setup();
    const serverId = insertServer(db, userId, { port, username: 'deploy' });
    await hostKeys.trust(at(serverId), {
      fingerprint: HOST_KEY.fingerprint,
      keyType: HOST_KEY.type,
      decidedBy: userId,
      allowPreTrust: true,
    });
    expect(await run(serverId)).toEqual({
      reachable: true,
      error: null,
      hostKey: { type: HOST_KEY.type, fingerprint: HOST_KEY.fingerprint, trusted: true },
      probe: null,
    });
    expect(attempts).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('with a credential and a trusted key it authenticates as the server’s user', async () => {
    const { db, hostKeys, userId, port, attempts, fetched, run, at } = await setup();
    const credentialId = insertCredential(db, userId);
    const serverId = insertServer(db, userId, { port, username: 'deploy', credentialId });

    // Unknown key: the handshake stops at the host key, before any login.
    expect((await run(serverId)).hostKey).toMatchObject({ trusted: false });
    expect(attempts).toEqual([]);

    await hostKeys.trust(at(serverId), {
      fingerprint: HOST_KEY.fingerprint,
      decidedBy: userId,
      allowPreTrust: false,
    });
    // This server refuses every login: the test reports why, the host key stays trusted.
    expect(await run(serverId)).toEqual({
      reachable: true,
      error: 'AUTH_REJECTED',
      hostKey: { type: HOST_KEY.type, fingerprint: HOST_KEY.fingerprint, trusted: true },
      probe: null,
    });
    expect(fetched).toEqual([credentialId, credentialId]);
    expect(attempts.length).toBeGreaterThan(0);
    expect(new Set(attempts.map((a) => a.username))).toEqual(new Set(['deploy']));
    expect(attempts.map((a) => a.method)).toContain('password');
  });
});

describe('server test: host keys per user and address (D-29)', () => {
  it("a key trusted through one server is trusted for the user's other servers at that address only", async () => {
    const { db, hostKeys, userId, port, run, at } = await setup();
    const first = insertServer(db, userId, { port, name: 'app' });
    const second = insertServer(db, userId, { port, name: 'app as root', username: 'root' });
    const other = insertUser(db);
    const theirs = insertServer(db, other, { port, name: 'app' });

    expect((await run(first)).hostKey).toMatchObject({ trusted: false });
    expect(await hostKeys.trustPending(at(first), HOST_KEY.fingerprint, userId)).toBe(true);
    // The other server of the same user at the same address: trusted, nothing new recorded.
    expect(await run(second)).toMatchObject({ reachable: true, hostKey: { trusted: true } });
    expect(await hostKeys.list(at(second))).toMatchObject([{ status: 'trusted' }]);

    // Another user's server at the same address: a first use of their own.
    expect(await run(theirs, other)).toMatchObject({
      reachable: true,
      hostKey: { trusted: false },
    });
    expect(await hostKeys.list(at(theirs, other))).toMatchObject([{ status: 'pending' }]);
    expect(await hostKeys.list(at(first))).toMatchObject([{ status: 'trusted' }]);
  });
});
