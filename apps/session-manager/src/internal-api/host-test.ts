import type { TermdockDb } from '@termdock/db';
import type { HostTestResponse } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import type { z } from 'zod';
import { decideHostKey } from '../core/transport-factory.ts';
import { type CredentialProvider, TransportError } from '../core/types.ts';
import { type ProbeResult, parseProbeOutput, probeCommand } from '../probe/index.ts';
import { requireActingUser } from '../store/access.ts';
import type { SqliteHostKeyStore } from '../store/host-key-store.ts';
import { getRow } from '../store/sqlite.ts';
import { type HostKeyDecision, type HostKeyInfo, SshTransport } from '../transport/ssh/index.ts';

export const HOST_TEST_READY_TIMEOUT_MS = 10_000;
export const HOST_TEST_PROBE_TIMEOUT_MS = 15_000;
/** SSH user name for a test without a profile: the handshake stops before authentication. */
const NO_PROFILE_USERNAME = 'termdock';

export interface HostTestDeps {
  db: TermdockDb;
  hostKeys: SqliteHostKeyStore;
  credentials: CredentialProvider;
  readyTimeoutMs?: number;
  probeTimeoutMs?: number;
}

export interface HostTestInput {
  actingUserId: string;
  hostId: string;
  profileId?: string | undefined;
}

/**
 * Internal API `hosts/:id/test` ("Fetch & verify", plan §5.9): connects to the host and reports
 * the presented host key. An unknown key is recorded as `pending` (then trusted via
 * `trust-key`); a mismatch is audited. Only with a profile and an already trusted key does the
 * test authenticate (profile user + credential) and run the capability probe. Without a profile
 * the handshake is aborted right after the host key, so no failed login reaches the host.
 * Host-key verification is never bypassed: the transport only proceeds on a trusted key.
 */
export async function testHost(
  deps: HostTestDeps,
  input: HostTestInput,
): Promise<z.infer<typeof HostTestResponse>> {
  const sqlite = deps.db.$client;
  requireActingUser(sqlite, input.actingUserId);
  const host = getRow<{ id: string; kind: string; hostname: string; port: number }>(
    sqlite,
    'SELECT id, kind, hostname, port FROM hosts WHERE id = ? AND user_id = ?',
    input.hostId,
    input.actingUserId,
  );
  if (!host) throw new TermdockError(ErrorCode.NotFound, 'host not found');
  if (host.kind !== 'ssh') {
    throw new TermdockError(ErrorCode.BadRequest, 'only ssh hosts can be tested');
  }
  const profile = input.profileId
    ? getRow<{ username: string; credential_id: string | null }>(
        sqlite,
        'SELECT username, credential_id FROM connection_profiles WHERE id = ? AND user_id = ? AND host_id = ?',
        input.profileId,
        input.actingUserId,
        host.id,
      )
    : undefined;
  if (input.profileId && !profile) throw new TermdockError(ErrorCode.NotFound, 'profile not found');
  const credential = profile?.credential_id
    ? await deps.credentials.get(profile.credential_id, input.actingUserId)
    : null;
  const trusted = await deps.hostKeys.trusted(host.id);

  // Written by the verifier callback during the handshake.
  const seen: { key?: HostKeyInfo; decision?: HostKeyDecision } = {};
  const transport = new SshTransport({
    host: host.hostname,
    port: host.port,
    username: profile?.username ?? NO_PROFILE_USERNAME,
    credential,
    verifyHostKey: (key) => {
      const decision = decideHostKey(trusted, key);
      seen.key = key;
      seen.decision = decision;
      // Without a profile there is nothing to authenticate with: stop after the host key.
      return profile ? decision : 'unknown';
    },
    preferredHostKeyTypes: [...trusted.keys()],
    readyTimeoutMs: deps.readyTimeoutMs ?? HOST_TEST_READY_TIMEOUT_MS,
  });
  let error: string | null = null;
  let probe: ProbeResult | null = null;
  try {
    await transport.connect(new AbortController().signal);
    probe = await runProbe(transport, deps.probeTimeoutMs ?? HOST_TEST_PROBE_TIMEOUT_MS);
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
  if (decision === 'unknown') await deps.hostKeys.recordPending(host.id, key);
  if (decision === 'trusted' && !trusted.get(key.type)?.publicKeyB64) {
    await deps.hostKeys.rememberPublicKey(host.id, key);
  }
  if (decision === 'mismatch') {
    deps.hostKeys.recordMismatch(host.id, key, input.actingUserId, { source: 'host_test' });
  }
  const isTrusted = decision === 'trusted';
  return {
    reachable: true,
    error: isTrusted
      ? profile
        ? error
        : null
      : decision === 'mismatch'
        ? ErrorCode.HostKeyMismatch
        : null,
    hostKey: { type: key.type, fingerprint: key.fingerprint, trusted: isTrusted },
    probe: probe?.raw ?? null,
  };
}

function errorCode(err: unknown): string {
  if (err instanceof TermdockError || err instanceof TransportError) return err.code;
  return ErrorCode.HostUnreachable;
}

async function runProbe(transport: SshTransport, timeoutMs: number): Promise<ProbeResult> {
  const channel = await transport.exec(probeCommand());
  const read = async (stream: AsyncIterable<Uint8Array>): Promise<Buffer> => {
    const parts: Uint8Array[] = [];
    for await (const part of stream) parts.push(part);
    return Buffer.concat(parts);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TransportError('PROBE_TIMEOUT', 'capability probe timed out', true)),
      timeoutMs,
    );
  });
  try {
    const [stdout] = await Promise.race([
      Promise.all([read(channel.stdout), read(channel.stderr), channel.exit]),
      timeout,
    ]);
    return parseProbeOutput(stdout.toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}
