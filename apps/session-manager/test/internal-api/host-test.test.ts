import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { HostTestResponse } from '@termdock/protocol';
import ssh2 from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialProvider } from '../../src/core/types.ts';
import { testHost } from '../../src/internal-api/host-test.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import { SqliteHostKeyStore } from '../../src/store/host-key-store.ts';
import { parsePublicKeyLine, TargetPolicy } from '../../src/transport/ssh/index.ts';
import { insertHost, insertUser, type TempDb, tempDb } from '../store/fixture.ts';

const KEYS = fileURLToPath(new URL('../../../../test/sshd/keys/', import.meta.url));
const HOST_PRIVATE_KEY = readFileSync(`${KEYS}ssh_host_ed25519_key`);
const HOST_KEY = parsePublicKeyLine(readFileSync(`${KEYS}ssh_host_ed25519_key.pub`, 'utf8'));
const OTHER_FINGERPRINT = `SHA256:${'Q'.repeat(43)}`;

/** An in-process SSH server presenting the committed test host key; nobody may log in. */
async function startServer(): Promise<{ port: number; close(): Promise<void> }> {
  const clients = new Set<ssh2.Connection>();
  const server = new ssh2.Server({ hostKeys: [HOST_PRIVATE_KEY] }, (client) => {
    clients.add(client);
    client.on('authentication', (ctx) => ctx.reject());
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    port,
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

async function setup() {
  fixture = tempDb();
  const { db } = fixture;
  const server = await startServer();
  stop = server.close;
  const hostKeys = new SqliteHostKeyStore(db, new BatchedWriter(db));
  const userId = insertUser(db);
  const deps = {
    db,
    hostKeys,
    // Tests without a profile never authenticate.
    credentials: {
      get: async () => {
        throw new Error('no credential in this test');
      },
    } satisfies CredentialProvider,
    // The test server listens on loopback.
    targetPolicy: new TargetPolicy({ allowLocalTargets: true, localAddresses: () => [] }),
    readyTimeoutMs: 5_000,
  };
  const run = async (hostId: string) =>
    HostTestResponse.parse(await testHost(deps, { actingUserId: userId, hostId }));
  return { db, hostKeys, userId, port: server.port, run };
}

describe('host test: a revoked key is reported as revoked, not as a plain mismatch', () => {
  it('flags `revoked: true` only when the presented key matches a revoked row', async () => {
    const { db, hostKeys, userId, port, run } = await setup();
    const hostId = insertHost(db, userId, { port });

    // Unknown key: recorded as pending, nothing flagged.
    const first = await run(hostId);
    expect(first).toEqual({
      reachable: true,
      error: null,
      hostKey: { type: 'ssh-ed25519', fingerprint: HOST_KEY.fingerprint, trusted: false },
      probe: null,
    });

    // Trusted: still nothing flagged.
    const trusted = await hostKeys.trust(hostId, {
      fingerprint: HOST_KEY.fingerprint,
      decidedBy: userId,
      allowPreTrust: false,
    });
    expect(trusted).toBe('trusted');
    const ok = await run(hostId);
    expect(ok).toMatchObject({ reachable: true, error: null, hostKey: { trusted: true } });
    expect(ok).not.toHaveProperty('revoked');

    // The owner revokes that very key: the next test says so (and keeps the old error code).
    expect(await hostKeys.revoke(hostId, 'ssh-ed25519', userId)).toBe(true);
    const revoked = await run(hostId);
    expect(revoked).toEqual({
      reachable: true,
      error: 'HOST_KEY_MISMATCH',
      hostKey: { type: 'ssh-ed25519', fingerprint: HOST_KEY.fingerprint, trusted: false },
      probe: null,
      revoked: true,
    });
  });

  it('a different trusted key is a mismatch without the revoked flag', async () => {
    const { db, hostKeys, userId, port, run } = await setup();
    const hostId = insertHost(db, userId, { port });
    const pretrusted = await hostKeys.trust(hostId, {
      fingerprint: OTHER_FINGERPRINT,
      keyType: 'ssh-ed25519',
      decidedBy: userId,
      allowPreTrust: true,
    });
    expect(pretrusted).toBe('trusted');
    const result = await run(hostId);
    expect(result).toMatchObject({
      reachable: true,
      error: 'HOST_KEY_MISMATCH',
      hostKey: { fingerprint: HOST_KEY.fingerprint, trusted: false },
    });
    expect(result).not.toHaveProperty('revoked');
  });
});
