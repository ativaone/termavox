import { z } from 'zod';
import { FileRequest, FileResult, TransferState } from '../files.ts';
import { Protection, SessionState, SessionStatus } from '../session-state.ts';

export const PROTOCOL_VERSION = 1;

/** WebSocket close codes (implementation plan §7.3). */
export const CloseCode = {
  BadRequest: 4400,
  Unauthenticated: 4401,
  Forbidden: 4403,
  ProtocolUnsupported: 4409,
  RateLimited: 4429,
  Internal: 4500,
} as const;

const channel = z.number().int().min(0).max(0xffff_ffff);
const id = z.string().min(1).max(64);
const dimension = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

// ── client → server ────────────────────────────────────────────────────────────

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.number().int(),
    ticket: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal('session.attach'), channel, sessionId: id, viewport: dimension }),
  z.object({ type: z.literal('session.detach'), channel }),
  z.object({
    type: z.literal('terminal.viewport'),
    channel,
    cols: dimension.shape.cols,
    rows: dimension.shape.rows,
  }),
  z.object({ type: z.literal('terminal.activate'), channel }),
  z.object({ type: z.literal('terminal.resync'), channel }),
  z.object({
    type: z.literal('hostkey.decision'),
    sessionId: id,
    fingerprint: z.string().max(128),
    accept: z.boolean(),
  }),
  z.object({
    type: z.literal('auth.response'),
    sessionId: id,
    promptId: id,
    answers: z.array(z.string().max(4096)).max(16),
  }),
  /** File panel (plan §5.12): answered by one `files.result` with the same `requestId`. */
  z.object({
    type: z.literal('files.request'),
    requestId: id,
    sessionId: id,
    request: FileRequest,
  }),
  /** Stops a request still running (a `remove`): its result is CANCELLED. */
  z.object({ type: z.literal('files.cancel'), requestId: id }),
  /** Stops an upload or a download, or voids its URL if it has not been used yet. */
  z.object({ type: z.literal('transfer.cancel'), transferId: id }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ── server → client ────────────────────────────────────────────────────────────

export const SessionSummary = z.object({
  id,
  label: z.string(),
  // The owner turned on desktop notifications for the bell (browser-side, open tabs only).
  notify: z.boolean(),
  serverId: id.nullable(), // null after the server was deleted (history)
  // The server's current name, or the snapshotted hostname once the server is gone.
  serverName: z.string(),
  // Snapshotted at creation (a local session: 'localhost', 0, '').
  kind: z.enum(['ssh', 'local']),
  hostname: z.string(),
  port: z.number().int(),
  username: z.string(),
  state: SessionState,
  status: SessionStatus,
  protection: Protection.nullable(), // null until the first probe decided it
  createdAt: z.number(),
  lastReadyAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  endReason: z.string().nullable(),
  // `detail` of the latest `session.status` (failure code, end reason, `remote_rebooted` …), so
  // a reloaded client can still say why; after a daemon restart, a failed session's last code.
  statusDetail: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Caps on host-provided keyboard-interactive text; the daemon trims to them before sending. */
export const AUTH_PROMPT_LIMITS = {
  name: 256,
  instructions: 2048,
  text: 256,
  prompts: 16,
} as const;

export const AuthPrompt = z.object({
  text: z.string().max(AUTH_PROMPT_LIMITS.text),
  echo: z.boolean(),
});

/** `nested_tmux`: the user runs tmux inside a tmux-protected session (plan D-33). */
export const TerminalHint = z.enum(['nested_tmux']);
export type TerminalHint = z.infer<typeof TerminalHint>;

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello.ok'),
    protocol: z.number().int(),
    userId: id,
    serverTime: z.number(),
  }),
  z.object({ type: z.literal('sessions.list'), sessions: z.array(SessionSummary) }),
  z.object({ type: z.literal('session.upsert'), session: SessionSummary }),
  z.object({ type: z.literal('session.removed'), sessionId: id }),
  /**
   * The terminal of a session rang its bell. Sent to every connection of the owner, attached to
   * it or not (browsers mark a session in any of their tabs, and notify when its desktop
   * notifications are on), at most once a second per session, with the terminal's current title (sanitized, null
   * when none was set); `terminal.bell` still goes to its attachments.
   */
  z.object({ type: z.literal('session.bell'), sessionId: id, title: z.string().nullable() }),
  z.object({
    type: z.literal('session.status'),
    sessionId: id,
    status: SessionStatus,
    state: SessionState,
    detail: z.string().optional(),
    retryInMs: z.number().int().optional(),
    /**
     * Carried by every status of a retry round (plan D-31), the attempts themselves included. A
     * session that never connected counts its attempts: `attempt` (the one running or next) of
     * `maxAttempts`. One that lost its connection retries until `retryUntil` (epoch ms). Live
     * only, like `retryInMs`: not part of the session summary.
     */
    attempt: z.number().int().min(1).optional(),
    maxAttempts: z.number().int().min(1).optional(),
    retryUntil: z.number().int().optional(),
    /**
     * With state `ended` (plan D-30): the session's tmux on the server could not be ended now
     * (unreachable, the sign-in would need a prompt, host key not trusted). The next connection
     * to that server as that user ends it. Live only: not part of the session summary.
     */
    remoteCleanup: z.literal('pending').optional(),
  }),
  z.object({
    type: z.literal('session.attached'),
    channel,
    sessionId: id,
    cols: z.number().int(),
    rows: z.number().int(),
    scrollbackLines: z.number().int(),
  }),
  z.object({
    type: z.literal('terminal.resized'),
    channel,
    cols: z.number().int(),
    rows: z.number().int(),
    /** Apply after every OUTPUT with seq <= this value and before later ones (plan §5.5). */
    seq: z.number().int().nonnegative(),
    activeAttachment: z.boolean(),
  }),
  z.object({ type: z.literal('terminal.title'), channel, title: z.string().max(256) }),
  z.object({ type: z.literal('terminal.bell'), channel }),
  /**
   * A tip for the pane while its condition holds; null clears it. Sent on change and right after
   * `session.attached` for a late attach (plan D-33).
   */
  z.object({ type: z.literal('terminal.hint'), channel, hint: TerminalHint.nullable() }),
  z.object({
    type: z.literal('hostkey.prompt'),
    sessionId: id,
    keyType: z.string(),
    fingerprint: z.string(),
    mismatch: z.boolean(),
    /** With `mismatch`: the presented key is one the owner revoked for this host. */
    revoked: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('auth.prompt'),
    sessionId: id,
    promptId: id,
    name: z.string().max(AUTH_PROMPT_LIMITS.name),
    instructions: z.string().max(AUTH_PROMPT_LIMITS.instructions),
    prompts: z.array(AuthPrompt).max(AUTH_PROMPT_LIMITS.prompts),
  }),
  z.object({
    // Plan D-30: a session's connection found Termavox tmux servers on its server that this
    // installation does not run (`unknown` or `other` origin). At most once per daemon run per
    // server and set of sockets; the server page lists them (remote-sessions scan).
    type: z.literal('server.remote_sessions'),
    serverId: id,
    serverName: z.string(),
    count: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('server.shutting_down'),
    expectedBackInMs: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    channel: channel.optional(),
    sessionId: id.optional(),
  }),
  /** Exactly one of `result` and `error` (plan §5.12). */
  z.object({
    type: z.literal('files.result'),
    requestId: id,
    result: FileResult.optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  /** A `remove` in progress: entries removed so far (at most about four per second). */
  z.object({
    type: z.literal('files.progress'),
    requestId: id,
    removed: z.number().int().nonnegative(),
  }),
  /**
   * An upload or download minted by this connection: bytes written to the server (upload) or sent
   * to the browser (download) so far. Sent when it starts, at most about four per second while it
   * runs, and once when it ends (`code` with `failed`).
   */
  z.object({
    type: z.literal('transfer.progress'),
    transferId: id,
    bytes: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    state: TransferState,
    code: z.string().optional(),
  }),
  z.object({ type: z.literal('pong'), t: z.number() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * Parses a text frame. Unknown message types are ignored (returns null) so additive
 * protocol changes stay compatible within v1; malformed known types throw, including a known
 * type whose nested union (a file request's `op`) has a value this side does not know.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  return parseWith(ClientMessage, raw);
}

export function parseServerMessage(raw: string): ServerMessage | null {
  return parseWith(ServerMessage, raw);
}

function parseWith<T>(schema: z.ZodType<T>, raw: string): T | null {
  const json: unknown = JSON.parse(raw);
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  const isKnownType =
    typeof json === 'object' &&
    json !== null &&
    'type' in json &&
    !result.error.issues.some(
      (issue) =>
        issue.code === 'invalid_union' && issue.path.length === 1 && issue.path[0] === 'type',
    );
  if (!isKnownType) return null;
  throw result.error;
}
