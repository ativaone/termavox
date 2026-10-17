import type { TermdockDb } from '@termdock/db';
import type { ServerTestResponse } from '@termdock/protocol';
import { ErrorCode, normalizeHostname, TermdockError } from '@termdock/shared';
import type { z } from 'zod';
import { decideHostKey } from '../core/transport-factory.ts';
import { type CredentialProvider, type HostKeyTarget, TransportError } from '../core/types.ts';
import { type ProbeResult, runProbe, storableProbe } from '../probe/index.ts';
import { requireActingUser } from '../store/access.ts';
import type { SqliteHostKeyStore } from '../store/host-key-store.ts';
import { getRow } from '../store/sqlite.ts';
import {
  type HostKeyDecision,
  type HostKeyInfo,
  SshTransport,
  type TargetPolicy,
} from '../transport/ssh/index.ts';

export const SERVER_TEST_READY_TIMEOUT_MS = 10_000;
export const SERVER_TEST_PROBE_TIMEOUT_MS = 15_000;

export interface ServerTestDeps {
  db: TermdockDb;
  hostKeys: SqliteHostKeyStore;
  credentials: CredentialProvider;
  /** The same target policy as sessions: a refused address reports TARGET_NOT_ALLOWED. */
  targetPolicy: TargetPolicy;
  readyTimeoutMs?: number;
  probeTimeoutMs?: number;
}

export interface ServerTestInput {
  actingUserId: string;
  serverId: string;
}

/**
 * Internal API `servers/:id/test` ("Fetch & verify", plan §5.9): connects to the server's address
 * and reports the presented host key, decided against the acting user's keys for that address
 * (D-29). An unknown key is recorded as `pending` for the address (then trusted via
 * `trust-key`); a mismatch, or a key the owner revoked, is audited and reported as
 * HOST_KEY_MISMATCH, a revoked one also with `revoked: true`. Only with an already trusted key
 * and a stored credential does the test authenticate (the server's user name and credential) and
 * run the capability probe. A server without a credential prompts in the terminal, which a test
 * cannot answer: its handshake is aborted right after the host key, so no failed login reaches
 * the host. Host-key verification is never bypassed: the transport only proceeds on a trusted key.
 */
export async function testServer(
  deps: ServerTestDeps,
  input: ServerTestInput,
): Promise<z.infer<typeof ServerTestResponse>> {
  const sqlite = deps.db.$client;
  requireActingUser(sqlite, input.actingUserId);
  const server = getRow<{
    id: string;
    kind: string;
    hostname: string | null;
    port: number | null;
    username: string | null;
    credential_id: string | null;
  }>(
    sqlite,
    'SELECT id, kind, hostname, port, username, credential_id FROM servers WHERE id = ? AND user_id = ?',
    input.serverId,
    input.actingUserId,
  );
  if (!server) throw new TermdockError(ErrorCode.NotFound, 'server not found');
  if (
    server.kind !== 'ssh' ||
    server.hostname === null ||
    server.port === null ||
    server.username === null
  ) {
    throw new TermdockError(ErrorCode.BadRequest, 'only ssh servers can be tested');
  }
  const target: HostKeyTarget = {
    userId: input.actingUserId,
    hostname: normalizeHostname(server.hostname),
    port: server.port,
    serverId: server.id,
  };
  const credential = server.credential_id
    ? await deps.credentials.get(server.credential_id, input.actingUserId)
    : null;
  const trusted = await deps.hostKeys.trusted(target);
  const revoked = await deps.hostKeys.revoked(target);

  // Written by the verifier callback during the handshake.
  const seen: { key?: HostKeyInfo; decision?: HostKeyDecision } = {};
  const transport = new SshTransport({
    host: target.hostname,
    port: target.port,
    username: server.username,
    credential,
    verifyHostKey: (key) => {
      const decision = decideHostKey(trusted, key, revoked);
      seen.key = key;
      seen.decision = decision;
      // Without a credential there is nothing to authenticate with: stop after the host key.
      return credential ? decision : 'unknown';
    },
    preferredHostKeyTypes: [...trusted.keys()],
    targetPolicy: deps.targetPolicy,
    readyTimeoutMs: deps.readyTimeoutMs ?? SERVER_TEST_READY_TIMEOUT_MS,
  });
  let error: string | null = null;
  let probe: ProbeResult | null = null;
  try {
    await transport.connect(new AbortController().signal);
    probe = await runProbe(transport, deps.probeTimeoutMs ?? SERVER_TEST_PROBE_TIMEOUT_MS);
  } catch (err) {
    error = errorCode(err);
  } finally {
    await transport.close().catch(() => {});
  }

  const { key, decision } = seen;
  if (!key || !decision) {
    return {
      reachable: false,
      error: error ?? ErrorCode.HostUnreachable,
      hostKey: null,
      probe: null,
    };
  }
  if (decision === 'unknown') await deps.hostKeys.recordPending(target, key);
  if (decision === 'trusted' && !trusted.get(key.type)?.publicKeyB64) {
    await deps.hostKeys.rememberPublicKey(target, key);
  }
  // `host_test` stays the audit source of "Fetch & verify" (web labels it).
  if (decision === 'mismatch') {
    deps.hostKeys.recordMismatch(target, key, input.actingUserId, { source: 'host_test' });
  }
  if (decision === 'revoked') {
    deps.hostKeys.recordRevokedPresented(target, key, input.actingUserId, {
      source: 'host_test',
    });
  }
  const isTrusted = decision === 'trusted';
  return {
    reachable: true,
    error: isTrusted
      ? credential
        ? error
        : null
      : decision === 'mismatch' || decision === 'revoked'
        ? ErrorCode.HostKeyMismatch
        : null,
    hostKey: { type: key.type, fingerprint: key.fingerprint, trusted: isTrusted },
    probe: probe ? storableProbe(probe.raw) : null,
    ...(decision === 'revoked' ? { revoked: true as const } : {}),
  };
}

function errorCode(err: unknown): string {
  if (err instanceof TermdockError || err instanceof TransportError) return err.code;
  return ErrorCode.HostUnreachable;
}
