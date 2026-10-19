import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TermdockDb } from '@termdock/db';
import {
  ActingUserRequest,
  AdoptRemoteSessionRequest,
  CreateCredentialRequest,
  CreateSessionRequest,
  INTERNAL_API_PREFIX,
  ListRemoteSessionsRequest,
  ListSessionsQuery,
  RemoveEndedSessionsRequest,
  RenameCredentialRequest,
  RenameSessionRequest,
  ReplaceHostKeyRequest,
  RevokeAuthSessionsRequest,
  RevokeHostKeyRequest,
  SESSION_LABEL_MAX,
  ServerTestRequest,
  type SessionSummary,
  TerminateAllSessionsRequest,
  TerminateRemoteSessionRequest,
  TerminateUserSessionsRequest,
  TrustHostKeyRequest,
} from '@termdock/protocol';
import { ErrorCode, normalizeHostname, TermdockError } from '@termdock/shared';
import type { z } from 'zod';
import { type Logger, silentLogger } from '../config/logger.ts';
import { tmuxSocketPrefix } from '../core/driver-factory.ts';
import { sanitizePromptText } from '../core/session-runtime.ts';
import type {
  CredentialProvider,
  HostKeyTarget,
  OwnershipCheck,
  SessionRecord,
} from '../core/types.ts';
import { isAdmin, requireActingUser } from '../store/access.ts';
import type { SqliteHostKeyStore } from '../store/host-key-store.ts';
import type { SqliteSessionStore } from '../store/session-store.ts';
import { getRow } from '../store/sqlite.ts';
import type { TargetPolicy } from '../transport/ssh/index.ts';
import type { CredentialService } from '../vault/credentials.ts';
import {
  listRemoteSessions,
  RemoteHostError,
  type RemoteSessionsDeps,
  remoteHostMessage,
  terminateRemoteSession,
} from './remote-sessions.ts';
import { type ServerTestDeps, testServer } from './server-test.ts';

export const MAX_BODY_BYTES = 64 * 1024;
/** Server tests per user and minute: each one opens an SSH connection to a user-chosen target. */
export const SERVER_TEST_LIMIT = { max: 10, windowMs: 60_000 } as const;
/** Remote-session lists and terminates per user and minute (plan D-30): each one connects too. */
export const REMOTE_SESSIONS_LIMIT = { max: 20, windowMs: 60_000 } as const;
/**
 * The size an adopted session starts at (plan D-30) until a viewer attaches: the adopt request
 * carries no viewport, and the first attachment resizes it.
 */
export const ADOPT_VIEWPORT = { cols: 120, rows: 40 } as const;
const CLOSE_GRACE_MS = 2_000;

/** What the internal API needs from the session registry (`SessionRegistry` satisfies it). */
export interface SessionControl {
  create(record: SessionRecord): unknown;
  /** Resolves once the session ended, or after a few seconds while its remote cleanup runs. */
  terminate(sessionId: string, actingUserId: string): Promise<void>;
  /** Every non-ended session of the user starts ending; resolves with how many (plan D-30). */
  terminateAll(userId: string): Promise<number>;
  retry(sessionId: string, actingUserId: string): Promise<void>;
  /** Ends the session's retry round (plan D-31); CONFLICT when it is not retrying. */
  stop(sessionId: string, actingUserId: string): Promise<void>;
  /** Deletes an ended session (plan D-32); CONFLICT when it has not ended. */
  remove(sessionId: string, actingUserId: string): Promise<void>;
  /** Deletes every ended session of the user (plan D-32); resolves with how many. */
  removeEnded(userId: string): Promise<number>;
  reopen(sessionId: string, actingUserId: string): Promise<{ sessionId: string }>;
  /** The stored label changed: update the live runtime and publish it to the owner. */
  renamed(sessionId: string, userId: string, label: string): Promise<void>;
  listForUser(userId: string): Promise<SessionSummary[]>;
  host(sessionId: string): { readonly attachmentCount: number } | undefined;
  readonly size: number;
}

/** What it needs from the WebSocket server (`WsServer` satisfies it). */
export interface ConnectionRevoker {
  revoke(target: { authSessionId?: string; userId?: string }): number;
}

export interface InternalApiOptions {
  host: string;
  port: number;
  /** Bearer token bytes (trimmed content of TERMDOCK_INTERNAL_TOKEN_FILE). */
  token: Uint8Array;
  db: TermdockDb;
  sessions: SqliteSessionStore;
  hostKeys: SqliteHostKeyStore;
  credentials: CredentialService;
  credentialProvider: CredentialProvider;
  ownership: OwnershipCheck;
  registry: SessionControl;
  connections: ConnectionRevoker;
  /** TERMDOCK_ENABLE_LOCAL_SHELL. */
  enableLocalShell: boolean;
  /** SSH target policy for server tests (the same one sessions use). */
  targetPolicy: TargetPolicy;
  /** Names this installation's tmux sockets (remote leftovers, plan D-30). */
  installationId: string;
  version: string;
  startedAt?: number;
  serverTest?: Pick<ServerTestDeps, 'readyTimeoutMs' | 'probeTimeoutMs'>;
  /** Test timings of the remote-session routes. */
  remoteSessions?: Pick<
    RemoteSessionsDeps,
    | 'readyTimeoutMs'
    | 'probeTimeoutMs'
    | 'scanTimeoutMs'
    | 'killTimeoutMs'
    | 'listBudgetMs'
    | 'routeDeadlineMs'
  >;
  logger?: Logger;
  now?: () => number;
}

/** An error answered with a specific HTTP status (`{ code, message }` body). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.BadRequest]: 400,
  [ErrorCode.CredentialInvalid]: 400,
  [ErrorCode.LabelInvalid]: 400,
  [ErrorCode.Unauthenticated]: 401,
  [ErrorCode.Forbidden]: 403,
  [ErrorCode.LocalShellDisabled]: 403,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.Conflict]: 409,
  [ErrorCode.SessionEnded]: 409,
  [ErrorCode.RateLimited]: 429,
};

/**
 * Constant-time bearer check: both sides are hashed with SHA-256 first, so `timingSafeEqual`
 * always compares 32 bytes and neither the content nor the length of the token leaks through
 * timing. Malformed headers go through the same comparison.
 */
export function bearerMatches(header: string | undefined, expectedDigest: Buffer): boolean {
  const match = typeof header === 'string' ? /^Bearer +(\S+)$/i.exec(header.trim()) : null;
  const given = createHash('sha256')
    .update(match?.[1] ?? '', 'utf8')
    .digest();
  return timingSafeEqual(given, expectedDigest) && match !== null;
}

export function tokenDigest(token: Uint8Array): Buffer {
  return createHash('sha256').update(token).digest();
}

interface RequestContext {
  params: string[];
  query: URLSearchParams;
  body: unknown;
}

interface Reply {
  status: number;
  body?: unknown;
}

type Handler = (ctx: RequestContext) => Promise<Reply>;

interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  pattern: RegExp;
  handler: Handler;
}

const ID = '([^/]{1,64})';
const NO_CONTENT: Reply = { status: 204 };

/** In-memory sliding-window counter per key (e.g. server tests per user). */
export class SlidingWindowLimit {
  readonly #hits = new Map<string, number[]>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Counts one more for `key`; false (and not counted) when its window is already full. */
  take(key: string): boolean {
    const now = this.#now();
    const since = now - this.#windowMs;
    if (this.#hits.size > 1024) {
      for (const [k, hits] of this.#hits) if ((hits.at(-1) ?? 0) <= since) this.#hits.delete(k);
    }
    const recent = (this.#hits.get(key) ?? []).filter((at) => at > since);
    const allowed = recent.length < this.#max;
    if (allowed) recent.push(now);
    this.#hits.set(key, recent);
    return allowed;
  }
}

/**
 * Internal API (plan §8.3) on its own `node:http` listener, reachable only from web. Every
 * request needs the bearer token (missing/wrong → 401). Bodies are JSON (≤ 64 KiB), validated
 * with the protocol schemas. Errors are `{ code, message }`.
 *
 * Ownership: every user-scoped route re-validates `actingUserId` against the DB — the acting
 * user must exist and not be banned (403), and a session, credential or server of another user
 * is answered with 404, exactly like a missing one (no id probing).
 */
export class InternalApi {
  readonly #options: InternalApiOptions;
  readonly #server: Server;
  readonly #tokenDigest: Buffer;
  readonly #routes: Route[];
  readonly #log: Logger;
  readonly #startedAt: number;
  readonly #serverTests: SlidingWindowLimit;
  readonly #remoteCalls: SlidingWindowLimit;

  constructor(options: InternalApiOptions) {
    this.#options = options;
    this.#tokenDigest = tokenDigest(options.token);
    this.#log = (options.logger ?? silentLogger()).child({ component: 'internal-api' });
    this.#startedAt = options.startedAt ?? Date.now();
    this.#serverTests = new SlidingWindowLimit(
      SERVER_TEST_LIMIT.max,
      SERVER_TEST_LIMIT.windowMs,
      options.now,
    );
    this.#remoteCalls = new SlidingWindowLimit(
      REMOTE_SESSIONS_LIMIT.max,
      REMOTE_SESSIONS_LIMIT.windowMs,
      options.now,
    );
    this.#routes = this.#buildRoutes();
    this.#server = createServer({ requestTimeout: 60_000, headersTimeout: 10_000 }, (req, res) => {
      void this.#handle(req, res);
    });
  }

  async listen(): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    return this.#server.address() as AddressInfo;
  }

  /** Stops accepting requests; in-flight ones get a short grace period. */
  async close(): Promise<void> {
    if (!this.#server.listening) return;
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#server.closeIdleConnections();
    const timer = setTimeout(() => this.#server.closeAllConnections(), CLOSE_GRACE_MS);
    await closed;
    clearTimeout(timer);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!bearerMatches(req.headers.authorization, this.#tokenDigest)) {
        throw new HttpError(401, ErrorCode.Unauthenticated, 'missing or invalid bearer token');
      }
      const url = new URL(req.url ?? '/', 'http://internal');
      const { route, params } = this.#match(req.method ?? 'GET', url.pathname);
      const body = route.method === 'GET' ? undefined : await readJsonBody(req);
      const reply = await route.handler({ params, query: url.searchParams, body });
      sendJson(res, reply.status, reply.body);
    } catch (err) {
      this.#sendError(req, res, err);
    }
  }

  #match(method: string, pathname: string): { route: Route; params: string[] } {
    let pathMatched = false;
    for (const route of this.#routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      let params: string[];
      try {
        params = match.slice(1).map((p) => decodeURIComponent(p));
      } catch {
        throw new HttpError(400, ErrorCode.BadRequest, 'malformed path');
      }
      return { route, params };
    }
    if (pathMatched) throw new HttpError(405, ErrorCode.BadRequest, 'method not allowed');
    throw new HttpError(404, ErrorCode.NotFound, 'no such route');
  }

  #sendError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
    let status = 500;
    let code: string = ErrorCode.Internal;
    let message = 'internal error';
    // What actually failed, for the debug log only (a remote host's transport text).
    let detail: string | undefined;
    if (err instanceof HttpError) {
      ({ status, code, message } = err);
    } else if (err instanceof TermdockError) {
      status = STATUS_BY_CODE[err.code] ?? 500;
      code = err.code;
      message = status === 500 ? 'internal error' : err.message;
    } else if (err instanceof RemoteHostError) {
      // The remote host failed, not the daemon (remote sessions, plan D-30). What ssh2, DNS or
      // the host said stays in the debug log: the body carries a fixed message per code.
      status = 502;
      code = err.code;
      message = remoteHostMessage(err.code);
      detail = err.message.slice(0, 300);
    }
    if (status >= 500 && status !== 502) {
      // Our own errors never carry secrets; request bodies are never logged.
      const e = err as Error;
      this.#log.error(
        { err: { name: e?.name, message: e?.message, code: (e as { code?: unknown })?.code } },
        'internal API request failed',
      );
    } else {
      this.#log.debug(
        { method: req.method, status, code, ...(detail !== undefined ? { detail } : {}) },
        'internal API request rejected',
      );
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // The body may not have been read (401, 413): do not keep the connection.
    res.setHeader('connection', 'close');
    sendJson(res, status, { code, message });
  }

  #buildRoutes(): Route[] {
    const p = INTERNAL_API_PREFIX;
    const path = (suffix: string): RegExp => new RegExp(`^${p}${suffix}$`);
    return [
      { method: 'POST', pattern: path('/sessions'), handler: (c) => this.#createSession(c) },
      { method: 'GET', pattern: path('/sessions'), handler: (c) => this.#listSessions(c) },
      {
        method: 'POST',
        pattern: path('/sessions/terminate-all'),
        handler: (c) => this.#terminateAllSessions(c),
      },
      {
        method: 'POST',
        pattern: path('/sessions/remove-ended'),
        handler: (c) => this.#removeEndedSessions(c),
      },
      {
        method: 'DELETE',
        pattern: path(`/sessions/${ID}`),
        handler: (c) => this.#sessionAction(c, 'remove'),
      },
      {
        method: 'PATCH',
        pattern: path(`/sessions/${ID}`),
        handler: (c) => this.#renameSession(c),
      },
      {
        method: 'POST',
        pattern: path(`/sessions/${ID}/terminate`),
        handler: (c) => this.#sessionAction(c, 'terminate'),
      },
      {
        method: 'POST',
        pattern: path(`/sessions/${ID}/retry`),
        handler: (c) => this.#sessionAction(c, 'retry'),
      },
      {
        method: 'POST',
        pattern: path(`/sessions/${ID}/stop`),
        handler: (c) => this.#sessionAction(c, 'stop'),
      },
      {
        method: 'POST',
        pattern: path(`/sessions/${ID}/reopen`),
        handler: (c) => this.#sessionAction(c, 'reopen'),
      },
      { method: 'POST', pattern: path('/credentials'), handler: (c) => this.#createCredential(c) },
      {
        method: 'PATCH',
        pattern: path(`/credentials/${ID}`),
        handler: (c) => this.#renameCredential(c),
      },
      {
        method: 'DELETE',
        pattern: path(`/credentials/${ID}`),
        handler: (c) => this.#deleteCredential(c),
      },
      {
        method: 'POST',
        pattern: path(`/servers/${ID}/test`),
        handler: (c) => this.#testServer(c),
      },
      {
        method: 'POST',
        pattern: path(`/servers/${ID}/trust-key`),
        handler: (c) => this.#trustKey(c),
      },
      {
        method: 'POST',
        pattern: path(`/servers/${ID}/replace-key`),
        handler: (c) => this.#replaceKey(c),
      },
      {
        method: 'POST',
        pattern: path(`/servers/${ID}/revoke-key`),
        handler: (c) => this.#revokeKey(c),
      },
      {
        method: 'POST',
        pattern: path(`/servers/${ID}/remote-sessions`),
        handler: (c) => this.#listRemoteSessions(c),
      },
      {
        method: 'POST',
        pattern: path(`/servers/${ID}/remote-sessions/terminate`),
        handler: (c) => this.#terminateRemoteSession(c),
      },
      {
        method: 'POST',
        pattern: path(`/servers/${ID}/remote-sessions/adopt`),
        handler: (c) => this.#adoptRemoteSession(c),
      },
      {
        method: 'POST',
        pattern: path(`/users/${ID}/terminate-sessions`),
        handler: (c) => this.#terminateUserSessions(c),
      },
      {
        method: 'POST',
        pattern: path('/auth-sessions/revoke'),
        handler: (c) => this.#revokeAuthSessions(c),
      },
      { method: 'GET', pattern: path('/health'), handler: async () => this.#health() },
    ];
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async #createSession(ctx: RequestContext): Promise<Reply> {
    const body = parse(CreateSessionRequest, ctx.body);
    const record = await this.#options.sessions.createFromServer({
      actingUserId: body.actingUserId,
      serverId: body.serverId,
      label: body.label === undefined ? undefined : sessionLabel(body.label),
      viewport: body.viewport,
      enableLocalShell: this.#options.enableLocalShell,
    });
    this.#options.registry.create(record);
    return { status: 201, body: { sessionId: record.id } };
  }

  async #listSessions(ctx: RequestContext): Promise<Reply> {
    const query = parse(ListSessionsQuery, {
      actingUserId: ctx.query.get('actingUserId') ?? undefined,
    });
    requireActingUser(this.#options.db.$client, query.actingUserId);
    const { registry } = this.#options;
    const summaries = await registry.listForUser(query.actingUserId);
    return {
      status: 200,
      body: {
        sessions: summaries.map((s) => ({
          sessionId: s.id,
          state: s.state,
          status: s.status,
          protection: s.protection,
          attachments: registry.host(s.id)?.attachmentCount ?? 0,
        })),
      },
    };
  }

  /**
   * Rename (D-28): `{ actingUserId, label }` → `200 { sessionId, label }` with the label as
   * stored. Any state, ended included. LABEL_INVALID (400) when the cleaned label is empty or too
   * long; a foreign session is 404. Every connection of the owner gets a `session.upsert`.
   */
  async #renameSession(ctx: RequestContext): Promise<Reply> {
    const body = parse(RenameSessionRequest, ctx.body);
    const label = sessionLabel(body.label);
    const sessionId = ctx.params[0]!;
    const { previous } = await this.#options.sessions.rename(body.actingUserId, sessionId, label);
    if (previous !== label) {
      await this.#options.registry.renamed(sessionId, body.actingUserId, label);
    }
    return { status: 200, body: { sessionId, label } };
  }

  async #sessionAction(
    ctx: RequestContext,
    action: 'terminate' | 'retry' | 'stop' | 'remove' | 'reopen',
  ): Promise<Reply> {
    const { actingUserId } = parse(ActingUserRequest, ctx.body);
    const sessionId = ctx.params[0]!;
    requireActingUser(this.#options.db.$client, actingUserId);
    if ((await this.#options.ownership.sessionOwner(sessionId)) !== actingUserId) {
      throw new TermdockError(ErrorCode.NotFound, 'session not found');
    }
    const { registry } = this.#options;
    if (action === 'reopen')
      return { status: 200, body: await registry.reopen(sessionId, actingUserId) };
    await registry[action](sessionId, actingUserId);
    return NO_CONTENT;
  }

  /**
   * "End all sessions" (plan D-30): every non-ended session of the acting user starts ending (4 at
   * a time); answers `{ terminated }` once each one is ending, within a few seconds, without
   * waiting for every remote cleanup (the ends arrive as `session.status`).
   */
  async #terminateAllSessions(ctx: RequestContext): Promise<Reply> {
    const { actingUserId } = parse(TerminateAllSessionsRequest, ctx.body);
    requireActingUser(this.#options.db.$client, actingUserId);
    const terminated = await this.#options.registry.terminateAll(actingUserId);
    this.#log.info({ userId: actingUserId, terminated }, 'terminated all sessions of a user');
    return { status: 200, body: { terminated } };
  }

  /** "Remove all ended" (plan D-32): every ended session of the acting user is deleted. */
  async #removeEndedSessions(ctx: RequestContext): Promise<Reply> {
    const { actingUserId } = parse(RemoveEndedSessionsRequest, ctx.body);
    requireActingUser(this.#options.db.$client, actingUserId);
    const removed = await this.#options.registry.removeEnded(actingUserId);
    return { status: 200, body: { removed } };
  }

  // ── credentials ───────────────────────────────────────────────────────────

  async #createCredential(ctx: RequestContext): Promise<Reply> {
    const body = parse(CreateCredentialRequest, ctx.body);
    return { status: 201, body: await this.#options.credentials.create(body) };
  }

  async #renameCredential(ctx: RequestContext): Promise<Reply> {
    const body = parse(RenameCredentialRequest, ctx.body);
    await this.#options.credentials.rename(body.actingUserId, ctx.params[0]!, body.name);
    return NO_CONTENT;
  }

  async #deleteCredential(ctx: RequestContext): Promise<Reply> {
    const { actingUserId } = parse(ActingUserRequest, ctx.body);
    await this.#options.credentials.delete(actingUserId, ctx.params[0]!);
    return NO_CONTENT;
  }

  // ── servers: test and host keys ───────────────────────────────────────────

  async #testServer(ctx: RequestContext): Promise<Reply> {
    const body = parse(ServerTestRequest, ctx.body);
    if (!this.#serverTests.take(body.actingUserId)) {
      throw new TermdockError(
        ErrorCode.RateLimited,
        `at most ${SERVER_TEST_LIMIT.max} server tests per minute; try again shortly`,
      );
    }
    const result = await testServer(
      {
        db: this.#options.db,
        hostKeys: this.#options.hostKeys,
        credentials: this.#options.credentialProvider,
        targetPolicy: this.#options.targetPolicy,
        ...this.#options.serverTest,
      },
      { actingUserId: body.actingUserId, serverId: ctx.params[0]! },
    );
    return { status: 200, body: result };
  }

  async #trustKey(ctx: RequestContext): Promise<Reply> {
    const body = parse(TrustHostKeyRequest, ctx.body);
    const target = this.#hostKeyTarget(ctx.params[0]!, body.actingUserId);
    const outcome = await this.#options.hostKeys.trust(target, {
      fingerprint: body.fingerprint,
      keyType: body.keyType,
      decidedBy: body.actingUserId,
      allowPreTrust: true,
    });
    if (outcome === 'conflict') {
      throw new TermdockError(
        ErrorCode.Conflict,
        'another key of this type is trusted for this address; use replace-key',
      );
    }
    if (outcome === 'revoked') {
      throw new TermdockError(
        ErrorCode.Conflict,
        'this key was revoked for this address; only replace-key can trust it again',
      );
    }
    return NO_CONTENT;
  }

  /**
   * The owner confirms by typing the address, since the change applies to every one of their
   * servers with it: `confirmHostname` must name the server's stored hostname (both normalized,
   * so `DB.Internal` confirms `db.internal`). Anything else is 400 and changes nothing.
   */
  async #replaceKey(ctx: RequestContext): Promise<Reply> {
    const body = parse(ReplaceHostKeyRequest, ctx.body);
    const target = this.#hostKeyTarget(ctx.params[0]!, body.actingUserId);
    if (normalizeHostname(body.confirmHostname) !== target.hostname) {
      throw new TermdockError(
        ErrorCode.BadRequest,
        'confirmHostname does not match the server hostname',
      );
    }
    await this.#options.hostKeys.replace(target, body.keyType, body.fingerprint, body.actingUserId);
    return NO_CONTENT;
  }

  async #revokeKey(ctx: RequestContext): Promise<Reply> {
    const body = parse(RevokeHostKeyRequest, ctx.body);
    const target = this.#hostKeyTarget(ctx.params[0]!, body.actingUserId);
    if (!(await this.#options.hostKeys.revoke(target, body.keyType, body.actingUserId))) {
      throw new TermdockError(ErrorCode.NotFound, 'no trusted key of this type');
    }
    return NO_CONTENT;
  }

  // ── servers: remote tmux leftovers (plan D-30) ────────────────────────────

  #remoteDeps(): RemoteSessionsDeps {
    return {
      db: this.#options.db,
      sessions: this.#options.sessions,
      hostKeys: this.#options.hostKeys,
      credentials: this.#options.credentialProvider,
      targetPolicy: this.#options.targetPolicy,
      installationId: this.#options.installationId,
      ...this.#options.remoteSessions,
      ...(this.#options.now ? { now: this.#options.now } : {}),
    };
  }

  /** Lists and terminates connect to a user-chosen target: limited per user like server tests. */
  #takeRemoteCall(actingUserId: string): void {
    if (!this.#remoteCalls.take(actingUserId)) {
      throw new TermdockError(
        ErrorCode.RateLimited,
        `at most ${REMOTE_SESSIONS_LIMIT.max} remote session requests per minute; try again shortly`,
      );
    }
  }

  async #listRemoteSessions(ctx: RequestContext): Promise<Reply> {
    const { actingUserId } = parse(ListRemoteSessionsRequest, ctx.body);
    this.#takeRemoteCall(actingUserId);
    const result = await listRemoteSessions(this.#remoteDeps(), {
      actingUserId,
      serverId: ctx.params[0]!,
    });
    return { status: 200, body: result };
  }

  async #terminateRemoteSession(ctx: RequestContext): Promise<Reply> {
    const body = parse(TerminateRemoteSessionRequest, ctx.body);
    this.#takeRemoteCall(body.actingUserId);
    const result = await terminateRemoteSession(this.#remoteDeps(), {
      actingUserId: body.actingUserId,
      serverId: ctx.params[0]!,
      socket: body.socket,
    });
    return { status: 200, body: result };
  }

  /**
   * Adopt (plan D-30): a new session of this server attached to that tmux server, created exactly
   * as `POST /sessions` creates one (target snapshot, label defaulting to the server's name, the
   * running-session cap), tmux-protected from the start and counted as ready before. Refused
   * (409) for a tmux server of a session that runs in Termdock, of another user's session, or of
   * one of the user's own ended sessions (reopen that one). Clients attached to it do not
   * prevent it (web asks the user first).
   */
  async #adoptRemoteSession(ctx: RequestContext): Promise<Reply> {
    const body = parse(AdoptRemoteSessionRequest, ctx.body);
    const record = await this.#options.sessions.createFromServer({
      actingUserId: body.actingUserId,
      serverId: ctx.params[0]!,
      label: body.label === undefined ? undefined : sessionLabel(body.label),
      viewport: ADOPT_VIEWPORT,
      enableLocalShell: this.#options.enableLocalShell,
      adopt: { socket: body.socket, ownPrefix: tmuxSocketPrefix(this.#options.installationId) },
    });
    this.#options.registry.create(record);
    return { status: 201, body: { sessionId: record.id } };
  }

  /**
   * The acting user's SSH server and the host-key target it names (plan §5.9, D-29): the server
   * id only picks the address (normalized hostname and port) and proves ownership; the decision
   * is stored for the address, so it applies to every server of that user with it. A foreign or
   * missing server is 404; a local server has no address (400).
   */
  #hostKeyTarget(serverId: string, actingUserId: string): HostKeyTarget {
    const sqlite = this.#options.db.$client;
    requireActingUser(sqlite, actingUserId);
    const server = getRow<{
      id: string;
      kind: string;
      hostname: string | null;
      port: number | null;
    }>(
      sqlite,
      'SELECT id, kind, hostname, port FROM servers WHERE id = ? AND user_id = ?',
      serverId,
      actingUserId,
    );
    if (!server) throw new TermdockError(ErrorCode.NotFound, 'server not found');
    if (server.kind !== 'ssh' || server.hostname === null || server.port === null) {
      throw new TermdockError(ErrorCode.BadRequest, 'a local server has no host keys');
    }
    return {
      userId: actingUserId,
      hostname: normalizeHostname(server.hostname),
      port: server.port,
      serverId: server.id,
    };
  }

  // ── admin ─────────────────────────────────────────────────────────────────

  /**
   * Terminates every non-ended session of the target user (admin "also terminate sessions").
   * The acting user must be an admin and not banned (403 otherwise); an unknown target is 404.
   * Each session is terminated as its owner, through the registry's own ownership check, 4 at a
   * time; the answer comes once each one is ending, inside web's 5 s timeout (remote cleanups,
   * plan D-30, continue after it).
   */
  async #terminateUserSessions(ctx: RequestContext): Promise<Reply> {
    const { actingUserId } = parse(TerminateUserSessionsRequest, ctx.body);
    const sqlite = this.#options.db.$client;
    const actor = requireActingUser(sqlite, actingUserId);
    if (!isAdmin(actor)) throw new TermdockError(ErrorCode.Forbidden, 'admin only');
    const targetId = ctx.params[0]!;
    const target = getRow<{ id: string }>(sqlite, 'SELECT id FROM user WHERE id = ?', targetId);
    if (!target) throw new TermdockError(ErrorCode.NotFound, 'user not found');
    const terminated = await this.#options.registry.terminateAll(target.id);
    this.#log.info({ targetUserId: target.id, terminated }, 'admin terminated user sessions');
    return { status: 200, body: { terminated } };
  }

  // ── system ────────────────────────────────────────────────────────────────

  async #revokeAuthSessions(ctx: RequestContext): Promise<Reply> {
    const body = parse(RevokeAuthSessionsRequest, ctx.body);
    this.#options.connections.revoke({
      ...(body.authSessionId !== undefined ? { authSessionId: body.authSessionId } : {}),
      ...(body.userId !== undefined ? { userId: body.userId } : {}),
    });
    return NO_CONTENT;
  }

  #health(): Reply {
    return {
      status: 200,
      body: {
        ok: true,
        sessions: this.#options.registry.size,
        uptimeMs: Date.now() - this.#startedAt,
        version: this.#options.version,
      },
    };
  }
}

/**
 * A session label as stored: control characters and invisible formatting dropped by the stripper
 * terminal titles and keyboard-interactive prompts go through (`max` = the input's own length, so
 * nothing is cut before the check), then trimmed; 1–120 characters, else LABEL_INVALID (400).
 */
export function sessionLabel(raw: string): string {
  const label = sanitizePromptText(raw, raw.length, false).trim();
  if (label.length === 0 || label.length > SESSION_LABEL_MAX) {
    throw new TermdockError(
      ErrorCode.LabelInvalid,
      `label must be 1 to ${SESSION_LABEL_MAX} characters once control and invisible formatting characters are removed`,
    );
  }
  return label;
}

/** Validates a body/query; 400 with the offending paths (never the submitted values). */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(body)'}: ${i.message}`);
  throw new HttpError(400, ErrorCode.BadRequest, `invalid request: ${issues.join('; ')}`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw new HttpError(413, ErrorCode.BadRequest, `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(
        413,
        ErrorCode.BadRequest,
        `request body exceeds ${MAX_BODY_BYTES} bytes`,
      );
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  try {
    if (raw.length === 0) throw new Error('empty');
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    // JSON.parse messages quote the input, and bodies may carry secrets: never echo them.
    throw new HttpError(400, ErrorCode.BadRequest, 'request body must be a JSON document');
  } finally {
    raw.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  if (status === 204 || body === undefined) {
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
