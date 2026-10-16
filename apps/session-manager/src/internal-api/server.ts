import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TermdockDb } from '@termdock/db';
import {
  ActingUserRequest,
  CreateCredentialRequest,
  CreateSessionRequest,
  HostTestRequest,
  INTERNAL_API_PREFIX,
  ListSessionsQuery,
  RenameCredentialRequest,
  ReplaceHostKeyRequest,
  RevokeAuthSessionsRequest,
  RevokeHostKeyRequest,
  type SessionSummary,
  TerminateUserSessionsRequest,
  TrustHostKeyRequest,
} from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import type { z } from 'zod';
import { type Logger, silentLogger } from '../config/logger.ts';
import type { CredentialProvider, OwnershipCheck, SessionRecord } from '../core/types.ts';
import { isAdmin, requireActingUser } from '../store/access.ts';
import type { SqliteHostKeyStore } from '../store/host-key-store.ts';
import type { SqliteSessionStore } from '../store/session-store.ts';
import { getRow } from '../store/sqlite.ts';
import type { CredentialService } from '../vault/credentials.ts';
import { type HostTestDeps, testHost } from './host-test.ts';

export const MAX_BODY_BYTES = 64 * 1024;
const CLOSE_GRACE_MS = 2_000;

/** What the internal API needs from the session registry (`SessionRegistry` satisfies it). */
export interface SessionControl {
  create(record: SessionRecord): unknown;
  terminate(sessionId: string, actingUserId: string): Promise<void>;
  retry(sessionId: string, actingUserId: string): Promise<void>;
  reopen(sessionId: string, actingUserId: string): Promise<{ sessionId: string }>;
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
  version: string;
  startedAt?: number;
  hostTest?: Pick<HostTestDeps, 'readyTimeoutMs' | 'probeTimeoutMs'>;
  logger?: Logger;
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

/**
 * Internal API (plan §8.3) on its own `node:http` listener, reachable only from web. Every
 * request needs the bearer token (missing/wrong → 401). Bodies are JSON (≤ 64 KiB), validated
 * with the protocol schemas. Errors are `{ code, message }`.
 *
 * Ownership: every user-scoped route re-validates `actingUserId` against the DB — the acting
 * user must exist and not be banned (403), and a session, credential, host or profile of
 * another user is answered with 404, exactly like a missing one (no id probing).
 */
export class InternalApi {
  readonly #options: InternalApiOptions;
  readonly #server: Server;
  readonly #tokenDigest: Buffer;
  readonly #routes: Route[];
  readonly #log: Logger;
  readonly #startedAt: number;

  constructor(options: InternalApiOptions) {
    this.#options = options;
    this.#tokenDigest = tokenDigest(options.token);
    this.#log = (options.logger ?? silentLogger()).child({ component: 'internal-api' });
    this.#startedAt = options.startedAt ?? Date.now();
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
    if (err instanceof HttpError) {
      ({ status, code, message } = err);
    } else if (err instanceof TermdockError) {
      status = STATUS_BY_CODE[err.code] ?? 500;
      code = err.code;
      message = status === 500 ? 'internal error' : err.message;
    }
    if (status >= 500) {
      // Our own errors never carry secrets; request bodies are never logged.
      const e = err as Error;
      this.#log.error(
        { err: { name: e?.name, message: e?.message, code: (e as { code?: unknown })?.code } },
        'internal API request failed',
      );
    } else {
      this.#log.debug({ method: req.method, status, code }, 'internal API request rejected');
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
      { method: 'POST', pattern: path(`/hosts/${ID}/test`), handler: (c) => this.#testHost(c) },
      {
        method: 'POST',
        pattern: path(`/hosts/${ID}/trust-key`),
        handler: (c) => this.#trustKey(c),
      },
      {
        method: 'POST',
        pattern: path(`/hosts/${ID}/replace-key`),
        handler: (c) => this.#replaceKey(c),
      },
      {
        method: 'POST',
        pattern: path(`/hosts/${ID}/revoke-key`),
        handler: (c) => this.#revokeKey(c),
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
    const record = await this.#options.sessions.createFromProfile({
      actingUserId: body.actingUserId,
      profileId: body.profileId,
      label: body.label,
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

  async #sessionAction(
    ctx: RequestContext,
    action: 'terminate' | 'retry' | 'reopen',
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

  // ── hosts ─────────────────────────────────────────────────────────────────

  async #testHost(ctx: RequestContext): Promise<Reply> {
    const body = parse(HostTestRequest, ctx.body);
    const result = await testHost(
      {
        db: this.#options.db,
        hostKeys: this.#options.hostKeys,
        credentials: this.#options.credentialProvider,
        ...this.#options.hostTest,
      },
      { actingUserId: body.actingUserId, hostId: ctx.params[0]!, profileId: body.profileId },
    );
    return { status: 200, body: result };
  }

  async #trustKey(ctx: RequestContext): Promise<Reply> {
    const body = parse(TrustHostKeyRequest, ctx.body);
    const host = this.#ownedHost(ctx.params[0]!, body.actingUserId);
    const outcome = await this.#options.hostKeys.trust(host.id, {
      fingerprint: body.fingerprint,
      keyType: body.keyType,
      decidedBy: body.actingUserId,
      allowPreTrust: true,
    });
    if (outcome === 'conflict') {
      throw new TermdockError(
        ErrorCode.Conflict,
        'another key of this type is trusted for the host; use replace-key',
      );
    }
    return NO_CONTENT;
  }

  async #replaceKey(ctx: RequestContext): Promise<Reply> {
    const body = parse(ReplaceHostKeyRequest, ctx.body);
    const host = this.#ownedHost(ctx.params[0]!, body.actingUserId);
    if (body.confirmHostName !== host.name) {
      throw new TermdockError(ErrorCode.BadRequest, 'confirmHostName does not match the host name');
    }
    await this.#options.hostKeys.replace(
      host.id,
      body.keyType,
      body.fingerprint,
      body.actingUserId,
    );
    return NO_CONTENT;
  }

  async #revokeKey(ctx: RequestContext): Promise<Reply> {
    const body = parse(RevokeHostKeyRequest, ctx.body);
    const host = this.#ownedHost(ctx.params[0]!, body.actingUserId);
    if (!(await this.#options.hostKeys.revoke(host.id, body.keyType, body.actingUserId))) {
      throw new TermdockError(ErrorCode.NotFound, 'no trusted key of this type');
    }
    return NO_CONTENT;
  }

  #ownedHost(hostId: string, actingUserId: string): { id: string; name: string } {
    const sqlite = this.#options.db.$client;
    requireActingUser(sqlite, actingUserId);
    const host = getRow<{ id: string; name: string }>(
      sqlite,
      'SELECT id, name FROM hosts WHERE id = ? AND user_id = ?',
      hostId,
      actingUserId,
    );
    if (!host) throw new TermdockError(ErrorCode.NotFound, 'host not found');
    return host;
  }

  // ── admin ─────────────────────────────────────────────────────────────────

  /**
   * Terminates every non-ended session of the target user (admin "also terminate sessions").
   * The acting user must be an admin and not banned (403 otherwise); an unknown target is 404.
   * Each session is terminated as its owner, through the registry's own ownership check.
   */
  async #terminateUserSessions(ctx: RequestContext): Promise<Reply> {
    const { actingUserId } = parse(TerminateUserSessionsRequest, ctx.body);
    const sqlite = this.#options.db.$client;
    const actor = requireActingUser(sqlite, actingUserId);
    if (!isAdmin(actor)) throw new TermdockError(ErrorCode.Forbidden, 'admin only');
    const targetId = ctx.params[0]!;
    const target = getRow<{ id: string }>(sqlite, 'SELECT id FROM user WHERE id = ?', targetId);
    if (!target) throw new TermdockError(ErrorCode.NotFound, 'user not found');
    const { registry } = this.#options;
    const live = (await registry.listForUser(target.id)).filter((s) => s.state !== 'ended');
    let terminated = 0;
    for (const session of live) {
      try {
        await registry.terminate(session.id, target.id);
        terminated++;
      } catch (err) {
        // Ended or removed meanwhile: nothing left to terminate.
        if (!(err instanceof TermdockError && err.code === ErrorCode.NotFound)) throw err;
      }
    }
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
