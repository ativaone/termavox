import type { TermdockDb } from '@termdock/db';
import type {
  ListRemoteSessionsResponse,
  RemoteSession,
  TerminateRemoteSessionResponse,
} from '@termdock/protocol';
import { ErrorCode, normalizeHostname, TermdockError } from '@termdock/shared';
import type { z } from 'zod';
import { tmuxSocketPrefix } from '../core/driver-factory.ts';
import {
  classifySocket,
  endLeftovers,
  endRemoteServer,
  type Leftover,
  type RemoteScanEntry,
  remoteServerAnswers,
  runRemoteScan,
  type SocketClass,
} from '../core/remote-sessions.ts';
import { decideHostKey } from '../core/transport-factory.ts';
import { type CredentialProvider, type HostKeyTarget, TransportError } from '../core/types.ts';
import { runProbe } from '../probe/index.ts';
import { requireActingUser } from '../store/access.ts';
import type { SqliteHostKeyStore } from '../store/host-key-store.ts';
import type { SqliteSessionStore } from '../store/session-store.ts';
import { getRow } from '../store/sqlite.ts';
import {
  type HostKeyDecision,
  type HostKeyInfo,
  SshTransport,
  type TargetPolicy,
} from '../transport/ssh/index.ts';

type ListedSession = z.infer<typeof RemoteSession>;

export const REMOTE_READY_TIMEOUT_MS = 10_000;
export const REMOTE_PROBE_TIMEOUT_MS = 5_000;
export const REMOTE_SCAN_TIMEOUT_MS = 5_000;
export const REMOTE_KILL_TIMEOUT_MS = 5_000;
/**
 * Leftover kills of a list start within this long of the request (web waits 30 s for these
 * calls); a leftover left out is listed as `ended`, for the user to end.
 */
export const REMOTE_LIST_BUDGET_MS = 20_000;
/**
 * Whatever still runs this long after the request started is cut off by closing the connection
 * (a channel that never opens, a host that stops answering): every route answers well inside 30 s.
 */
export const REMOTE_ROUTE_DEADLINE_MS = 25_000;

export interface RemoteSessionsDeps {
  db: TermdockDb;
  /** Session records: socket owners (writes still queued included), events, audits. */
  sessions: SqliteSessionStore;
  hostKeys: SqliteHostKeyStore;
  credentials: CredentialProvider;
  /** The same target policy as sessions: a refused address reports TARGET_NOT_ALLOWED. */
  targetPolicy: TargetPolicy;
  installationId: string;
  readyTimeoutMs?: number;
  probeTimeoutMs?: number;
  scanTimeoutMs?: number;
  killTimeoutMs?: number;
  listBudgetMs?: number;
  routeDeadlineMs?: number;
  now?: () => number;
}

/** Closes `transport` once the route's hard deadline passes; call the result when done. */
function hardStop(
  deps: RemoteSessionsDeps,
  startedAt: number,
  transport: SshTransport,
): () => void {
  const now = deps.now ?? Date.now;
  const left = startedAt + (deps.routeDeadlineMs ?? REMOTE_ROUTE_DEADLINE_MS) - now();
  const timer = setTimeout(() => void transport.close().catch(() => {}), Math.max(0, left));
  return () => clearTimeout(timer);
}

/**
 * The remote host could not be reached, signed in to or asked (terminate route; the internal API
 * answers `502 { code, message }`). `code` is the one a list reports in `error`.
 */
export class RemoteHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteHostError';
    this.code = code;
  }
}

interface OwnedServer {
  id: string;
  hostname: string;
  port: number;
  username: string;
  credentialId: string | null;
}

/** The acting user's SSH server (404 when missing or foreign, 400 for a local server). */
function ownedSshServer(deps: RemoteSessionsDeps, actingUserId: string, id: string): OwnedServer {
  const sqlite = deps.db.$client;
  requireActingUser(sqlite, actingUserId);
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
    id,
    actingUserId,
  );
  if (!server) throw new TermdockError(ErrorCode.NotFound, 'server not found');
  if (
    server.kind !== 'ssh' ||
    server.hostname === null ||
    server.port === null ||
    server.username === null
  ) {
    throw new TermdockError(ErrorCode.BadRequest, 'a local server has no remote sessions');
  }
  return {
    id: server.id,
    hostname: server.hostname,
    port: server.port,
    username: server.username,
    credentialId: server.credential_id,
  };
}

/**
 * A connection to the server as its user (modelled on the server test, plan §5.9): the stored
 * credential, the user's trusted key of the address, never a prompt (a keyboard-interactive round
 * other than the stored password fails it). Without a credential nothing is contacted
 * (CREDENTIAL_REQUIRED). An unknown key is recorded as `pending` for the address exactly as the
 * server test does, so it can be trusted on the server page, and fails with HOST_KEY_REJECTED; a
 * mismatch or a revoked key is audited and fails with HOST_KEY_MISMATCH.
 */
async function connectAsServer(
  deps: RemoteSessionsDeps,
  server: OwnedServer,
  actingUserId: string,
): Promise<SshTransport> {
  if (!server.credentialId) {
    throw new RemoteHostError(
      ErrorCode.CredentialRequired,
      'the server has no stored credential: its sign-in would need a prompt',
    );
  }
  const target: HostKeyTarget = {
    userId: actingUserId,
    hostname: normalizeHostname(server.hostname),
    port: server.port,
    serverId: server.id,
  };
  const credential = await deps.credentials.get(server.credentialId, actingUserId);
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
      return decision;
    },
    preferredHostKeyTypes: [...trusted.keys()],
    targetPolicy: deps.targetPolicy,
    readyTimeoutMs: deps.readyTimeoutMs ?? REMOTE_READY_TIMEOUT_MS,
  });
  try {
    await transport.connect(new AbortController().signal);
  } catch (err) {
    await transport.close().catch(() => {});
    const { key, decision } = seen;
    if (key && decision === 'unknown') await deps.hostKeys.recordPending(target, key);
    if (key && decision === 'mismatch') {
      deps.hostKeys.recordMismatch(target, key, actingUserId, { source: 'remote_sessions' });
    }
    if (key && decision === 'revoked') {
      deps.hostKeys.recordRevokedPresented(target, key, actingUserId, {
        source: 'remote_sessions',
      });
    }
    throw err;
  }
  const { key, decision } = seen;
  if (key && decision === 'trusted' && !trusted.get(key.type)?.publicKeyB64) {
    await deps.hostKeys.rememberPublicKey(target, key);
  }
  return transport;
}

/** The code a list reports in `error` (and a terminate in its 502). */
function failureCode(err: unknown): string {
  if (err instanceof RemoteHostError || err instanceof TransportError) return err.code;
  if (err instanceof TermdockError) return err.code;
  return ErrorCode.HostUnreachable;
}

function listed(
  entry: RemoteScanEntry,
  origin: ListedSession['origin'],
  owner: Leftover['owner'] | null,
): ListedSession {
  return {
    socket: entry.socket,
    origin,
    sessionId: owner?.sessionId ?? null,
    label: owner?.label ?? null,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    attachedClients: entry.attachedClients,
  };
}

const ORIGIN_ORDER: Record<ListedSession['origin'], number> = { ended: 0, unknown: 1, other: 2 };

/**
 * `POST /servers/:id/remote-sessions` (plan D-30): connects as the server's user, lists the
 * Termdock tmux servers there, ends at once the leftovers of sessions the acting user already
 * ended (re-checked right before each kill, never one ended less than 60 s ago), and lists the
 * rest: `unknown` and `other` servers, and leftovers whose kill failed (`ended`). Sessions that
 * run in Termdock, and other users' sessions, are never listed. A failure to connect, sign in,
 * probe or scan is reported in `error` with an empty list.
 */
export async function listRemoteSessions(
  deps: RemoteSessionsDeps,
  input: { actingUserId: string; serverId: string },
): Promise<z.infer<typeof ListRemoteSessionsResponse>> {
  const server = ownedSshServer(deps, input.actingUserId, input.serverId);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + (deps.listBudgetMs ?? REMOTE_LIST_BUDGET_MS);
  const empty = (error: string | null) => ({ error, sessions: [], cleaned: 0, truncated: false });
  let transport: SshTransport;
  try {
    transport = await connectAsServer(deps, server, input.actingUserId);
  } catch (err) {
    return empty(failureCode(err));
  }
  const stop = hardStop(deps, startedAt, transport);
  try {
    const { tmuxPath } = await runProbe(transport, deps.probeTimeoutMs ?? REMOTE_PROBE_TIMEOUT_MS);
    // Without tmux there is no Termdock tmux server to find.
    if (!tmuxPath) return empty(null);
    const scan = await runRemoteScan(transport, tmuxPath, {
      timeoutMs: deps.scanTimeoutMs ?? REMOTE_SCAN_TIMEOUT_MS,
    });
    const prefix = tmuxSocketPrefix(deps.installationId);
    const owners = await deps.sessions.socketOwners(
      scan.entries.map((e) => e.socket),
      prefix,
    );
    const sessions: ListedSession[] = [];
    const leftovers: Leftover[] = [];
    for (const entry of scan.entries) {
      const found = classifySocket(entry.socket, owners, input.actingUserId, prefix);
      if (found.kind === 'ended') leftovers.push({ entry, owner: found.owner });
      else if (found.kind === 'unknown' || found.kind === 'other') {
        sessions.push(listed(entry, found.kind, null));
      }
    }
    const { cleaned, failed } = await endLeftovers({
      transport,
      tmuxPath,
      leftovers,
      lookup: deps.sessions,
      actingUserId: input.actingUserId,
      ownPrefix: prefix,
      source: 'scan',
      now,
      deadline,
      killTimeoutMs: deps.killTimeoutMs ?? REMOTE_KILL_TIMEOUT_MS,
    });
    for (const { entry, owner } of failed) sessions.push(listed(entry, 'ended', owner));
    sessions.sort(
      (a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin] || (a.socket < b.socket ? -1 : 1),
    );
    return { error: null, sessions, cleaned, truncated: scan.truncated };
  } catch (err) {
    return empty(failureCode(err));
  } finally {
    stop();
    await transport.close().catch(() => {});
  }
}

/** Plan D-30: a tmux server of a session that runs in Termdock, or another user's, is refused. */
function assertNotTermdock(found: SocketClass): void {
  if (found.kind === 'running' || found.kind === 'foreign') {
    throw new TermdockError(ErrorCode.Conflict, 'this tmux server belongs to a Termdock session');
  }
}

/**
 * `POST /servers/:id/remote-sessions/terminate` (plan D-30): ends one tmux server on the server.
 * Refused (409) when it belongs to a session that runs in Termdock or to another user's session,
 * checked again right before the kill. `terminated: false` when no server answered for that
 * socket (nothing is removed). A failure to connect, sign in or ask the host throws
 * RemoteHostError (502). Audited as `remote_session.terminated` with how it was classified.
 */
export async function terminateRemoteSession(
  deps: RemoteSessionsDeps,
  input: { actingUserId: string; serverId: string; socket: string },
): Promise<z.infer<typeof TerminateRemoteSessionResponse>> {
  const server = ownedSshServer(deps, input.actingUserId, input.serverId);
  const startedAt = (deps.now ?? Date.now)();
  const prefix = tmuxSocketPrefix(deps.installationId);
  const classify = async (): Promise<SocketClass> =>
    classifySocket(
      input.socket,
      await deps.sessions.socketOwners([input.socket], prefix),
      input.actingUserId,
      prefix,
    );
  assertNotTermdock(await classify());
  let transport: SshTransport;
  try {
    transport = await connectAsServer(deps, server, input.actingUserId);
  } catch (err) {
    throw asRemoteHostError(err);
  }
  const stop = hardStop(deps, startedAt, transport);
  try {
    const killTimeout = deps.killTimeoutMs ?? REMOTE_KILL_TIMEOUT_MS;
    const { tmuxPath } = await runProbe(transport, deps.probeTimeoutMs ?? REMOTE_PROBE_TIMEOUT_MS);
    if (!tmuxPath) return { terminated: false };
    if (!(await remoteServerAnswers(transport, tmuxPath, input.socket, killTimeout))) {
      return { terminated: false };
    }
    // A session may have attached (Reopen, adopt) while this connection was opening.
    const found = await classify();
    assertNotTermdock(found);
    await endRemoteServer(transport, tmuxPath, input.socket, killTimeout);
    const origin = found.kind === 'ended' ? 'ended' : found.kind;
    deps.sessions.auditRemoteTermination({
      actorUserId: input.actingUserId,
      serverId: server.id,
      socket: input.socket,
      origin,
    });
    if (found.kind === 'ended') {
      deps.sessions.appendEvent(found.owner.sessionId, {
        type: 'remote_cleanup',
        detail: { source: 'manual' },
        actorUserId: input.actingUserId,
      });
    }
    return { terminated: true };
  } catch (err) {
    if (err instanceof TermdockError && err.code === ErrorCode.Conflict) throw err;
    throw asRemoteHostError(err);
  } finally {
    stop();
    await transport.close().catch(() => {});
  }
}

function asRemoteHostError(err: unknown): RemoteHostError {
  if (err instanceof RemoteHostError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new RemoteHostError(failureCode(err), message);
}
