import './server-guard.ts';
import {
  ActingUserRequest,
  CreateCredentialRequest,
  CreateCredentialResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  HealthResponse,
  INTERNAL_API_PREFIX,
  ListSessionsResponse,
  RenameCredentialRequest,
  RenameSessionRequest,
  RenameSessionResponse,
  ReplaceHostKeyRequest,
  RevokeAuthSessionsRequest,
  RevokeHostKeyRequest,
  ServerTestRequest,
  ServerTestResponse,
  TerminateUserSessionsRequest,
  TerminateUserSessionsResponse,
  TrustHostKeyRequest,
} from '@termdock/protocol';
import type { z } from 'zod';
import { loadWebConfig, readSecretFileSync } from './config.ts';

/**
 * Client of session-manager's internal API (plan §8.3), for Server Actions only. Requests are
 * validated with the protocol schemas before they leave and responses after they arrive. Bodies
 * may carry secrets (credential passwords, private keys): they are never logged, and errors
 * never quote them. Daemon error messages are safe to surface (it never echoes input).
 */

export type InternalApiErrorKind =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  /** No HTTP answer: connection refused, DNS, reset. */
  | 'unavailable'
  /** No answer within the call's time budget. */
  | 'timeout'
  /** An answer that does not match the protocol schema. */
  | 'bad_response';

const KIND_BY_STATUS: Record<number, InternalApiErrorKind> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'bad_request',
  429: 'rate_limited',
};

/** A failed internal API call: `status` is 0 when no HTTP answer arrived. */
export class InternalApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly kind: InternalApiErrorKind;

  constructor(kind: InternalApiErrorKind, status: number, code: string, message: string) {
    super(message);
    this.name = 'InternalApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export function isInternalApiError(err: unknown): err is InternalApiError {
  return err instanceof InternalApiError;
}

export interface InternalApiClientOptions {
  /** TERMDOCK_INTERNAL_URL, e.g. `http://session-manager:3002`. */
  baseUrl: string;
  /** Trimmed content of TERMDOCK_INTERNAL_TOKEN_FILE. */
  token: string;
  /** Default time budget per call. */
  timeoutMs?: number;
  /** Budget for `servers/:id/test` (SSH handshake up to 10 s plus the probe up to 15 s). */
  serverTestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const SERVER_TEST_TIMEOUT_MS = 30_000;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type CreateSessionInput = z.input<typeof CreateSessionRequest>;
export type CreateCredentialInput = z.input<typeof CreateCredentialRequest>;
export type CreateCredentialResult = z.infer<typeof CreateCredentialResponse>;
export type ServerTestResult = z.infer<typeof ServerTestResponse>;
export type LiveSessions = z.infer<typeof ListSessionsResponse>;

export class InternalApiClient {
  readonly #base: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #serverTestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: InternalApiClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, '') + INTERNAL_API_PREFIX;
    this.#authorization = `Bearer ${options.token}`;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#serverTestTimeoutMs = options.serverTestTimeoutMs ?? SERVER_TEST_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<{ sessionId: string }> {
    const body = request(CreateSessionRequest, input);
    return this.#call('POST', '/sessions', body, CreateSessionResponse);
  }

  async terminateSession(sessionId: string, actingUserId: string): Promise<void> {
    return this.#sessionAction(sessionId, 'terminate', actingUserId);
  }

  async retrySession(sessionId: string, actingUserId: string): Promise<void> {
    return this.#sessionAction(sessionId, 'retry', actingUserId);
  }

  async reopenSession(sessionId: string, actingUserId: string): Promise<{ sessionId: string }> {
    const body = request(ActingUserRequest, { actingUserId });
    return this.#call('POST', `/sessions/${seg(sessionId)}/reopen`, body, CreateSessionResponse);
  }

  /** Renames a session (any state); resolves with the label as stored (cleaned and trimmed). */
  async renameSession(
    sessionId: string,
    actingUserId: string,
    label: string,
  ): Promise<{ sessionId: string; label: string }> {
    const body = request(RenameSessionRequest, { actingUserId, label });
    return this.#call('PATCH', `/sessions/${seg(sessionId)}`, body, RenameSessionResponse);
  }

  async listSessions(actingUserId: string): Promise<LiveSessions> {
    const query = new URLSearchParams({ actingUserId }).toString();
    return this.#call('GET', `/sessions?${query}`, undefined, ListSessionsResponse);
  }

  // ── credentials ───────────────────────────────────────────────────────────

  async createCredential(input: CreateCredentialInput): Promise<CreateCredentialResult> {
    const body = request(CreateCredentialRequest, input);
    return this.#call('POST', '/credentials', body, CreateCredentialResponse);
  }

  async renameCredential(credentialId: string, actingUserId: string, name: string): Promise<void> {
    const body = request(RenameCredentialRequest, { actingUserId, name });
    return this.#call('PATCH', `/credentials/${seg(credentialId)}`, body, null);
  }

  async deleteCredential(credentialId: string, actingUserId: string): Promise<void> {
    const body = request(ActingUserRequest, { actingUserId });
    return this.#call('DELETE', `/credentials/${seg(credentialId)}`, body, null);
  }

  // ── servers (plan D-29) ───────────────────────────────────────────────────

  /**
   * "Test connection": connects to the server's address, records an unknown host key as pending
   * for that address, and probes with the server's own user name and credential.
   */
  async testServer(serverId: string, actingUserId: string): Promise<ServerTestResult> {
    const body = request(ServerTestRequest, { actingUserId });
    return this.#call(
      'POST',
      `/servers/${seg(serverId)}/test`,
      body,
      ServerTestResponse,
      this.#serverTestTimeoutMs,
    );
  }

  /** Host-key decisions are stored for the server's address (every server of the user there). */
  async trustHostKey(
    serverId: string,
    input: { actingUserId: string; keyType: string; fingerprint: string },
  ): Promise<void> {
    const body = request(TrustHostKeyRequest, input);
    return this.#call('POST', `/servers/${seg(serverId)}/trust-key`, body, null);
  }

  /** `confirmHostname` must equal the server's stored hostname. */
  async replaceHostKey(
    serverId: string,
    input: { actingUserId: string; keyType: string; fingerprint: string; confirmHostname: string },
  ): Promise<void> {
    const body = request(ReplaceHostKeyRequest, input);
    return this.#call('POST', `/servers/${seg(serverId)}/replace-key`, body, null);
  }

  async revokeHostKey(
    serverId: string,
    input: { actingUserId: string; keyType: string },
  ): Promise<void> {
    const body = request(RevokeHostKeyRequest, input);
    return this.#call('POST', `/servers/${seg(serverId)}/revoke-key`, body, null);
  }

  // ── admin / system ────────────────────────────────────────────────────────

  /** Closes the WebSockets of an auth session or of every auth session of a user. */
  async revokeAuthSessions(target: { authSessionId?: string; userId?: string }): Promise<void> {
    const body = request(RevokeAuthSessionsRequest, target);
    return this.#call('POST', '/auth-sessions/revoke', body, null);
  }

  async terminateUserSessions(
    userId: string,
    actingUserId: string,
  ): Promise<{ terminated: number }> {
    const body = request(TerminateUserSessionsRequest, { actingUserId });
    return this.#call(
      'POST',
      `/users/${seg(userId)}/terminate-sessions`,
      body,
      TerminateUserSessionsResponse,
    );
  }

  async health(): Promise<z.infer<typeof HealthResponse>> {
    return this.#call('GET', '/health', undefined, HealthResponse);
  }

  // ── transport ─────────────────────────────────────────────────────────────

  async #sessionAction(
    sessionId: string,
    action: 'terminate' | 'retry',
    actingUserId: string,
  ): Promise<void> {
    const body = request(ActingUserRequest, { actingUserId });
    return this.#call('POST', `/sessions/${seg(sessionId)}/${action}`, body, null);
  }

  #call<S extends z.ZodType>(
    method: Method,
    path: string,
    body: unknown,
    schema: S,
    timeoutMs?: number,
  ): Promise<z.infer<S>>;
  #call(
    method: Method,
    path: string,
    body: unknown,
    schema: null,
    timeoutMs?: number,
  ): Promise<void>;
  async #call(
    method: Method,
    path: string,
    body: unknown,
    schema: z.ZodType | null,
    timeoutMs = this.#timeoutMs,
  ): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: this.#authorization,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      text = await res.text();
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new InternalApiError(
          'timeout',
          0,
          'TIMEOUT',
          'session service did not answer in time',
        );
      }
      throw new InternalApiError('unavailable', 0, 'UNAVAILABLE', 'session service is unreachable');
    }

    if (!res.ok) {
      const error = errorBody(text);
      throw new InternalApiError(
        KIND_BY_STATUS[res.status] ?? 'server',
        res.status,
        error.code ?? `HTTP_${res.status}`,
        error.message ?? `session service answered ${res.status}`,
      );
    }
    if (schema === null) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw badResponse(res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw badResponse(res.status);
    return parsed.data;
  }
}

function seg(id: string): string {
  return encodeURIComponent(id);
}

/** Validates an outgoing body; the error never carries the submitted values. */
function request<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map((i) => i.path.join('.') || '(body)').join(', ');
  throw new InternalApiError('bad_request', 0, 'BAD_REQUEST', `invalid request: ${fields}`);
}

function errorBody(text: string): { code?: string; message?: string } {
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    return {
      ...(typeof body.code === 'string' ? { code: body.code } : {}),
      ...(typeof body.message === 'string' ? { message: body.message.slice(0, 300) } : {}),
    };
  } catch {
    return {};
  }
}

function badResponse(status: number): InternalApiError {
  return new InternalApiError(
    'bad_response',
    status,
    'BAD_RESPONSE',
    'session service sent an unexpected answer',
  );
}

/**
 * The process-wide client, built on first use from the environment (never at import, so
 * `next build` needs no secrets) and kept on globalThis like the auth runtime.
 */
const holder = globalThis as unknown as { __termdockInternalApi?: InternalApiClient };

/**
 * Closes WebSockets through the daemon (`auth-sessions/revoke`) for Server Actions; rejects
 * (never throws) when the daemon or its configuration is unavailable.
 */
export async function revokeConnections(target: {
  authSessionId?: string;
  userId?: string;
}): Promise<void> {
  await getInternalApi().revokeAuthSessions(target);
}

export function getInternalApi(): InternalApiClient {
  if (!holder.__termdockInternalApi) {
    const config = loadWebConfig();
    holder.__termdockInternalApi = new InternalApiClient({
      baseUrl: config.internalUrl,
      token: readSecretFileSync(config.internalTokenFile),
    });
  }
  return holder.__termdockInternalApi;
}
