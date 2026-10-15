import { z } from 'zod';
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
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ── server → client ────────────────────────────────────────────────────────────

export const SessionSummary = z.object({
  id,
  label: z.string(),
  profileId: id.nullable(), // null after the profile was deleted (history)
  hostId: id.nullable(),
  hostName: z.string(),
  hostname: z.string(),
  username: z.string(),
  state: SessionState,
  status: SessionStatus,
  protection: Protection.nullable(), // null until the first probe decided it
  createdAt: z.number(),
  lastReadyAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  endReason: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const AuthPrompt = z.object({ text: z.string(), echo: z.boolean() });

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
  z.object({
    type: z.literal('session.status'),
    sessionId: id,
    status: SessionStatus,
    state: SessionState,
    detail: z.string().optional(),
    retryInMs: z.number().int().optional(),
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
  z.object({
    type: z.literal('hostkey.prompt'),
    sessionId: id,
    keyType: z.string(),
    fingerprint: z.string(),
    mismatch: z.boolean(),
  }),
  z.object({
    type: z.literal('auth.prompt'),
    sessionId: id,
    promptId: id,
    name: z.string(),
    instructions: z.string(),
    prompts: z.array(AuthPrompt),
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
  z.object({ type: z.literal('pong'), t: z.number() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * Parses a text frame. Unknown message types are ignored (returns null) so additive
 * protocol changes stay compatible within v1; malformed known types throw.
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
    result.error.issues.every((issue) => issue.code !== 'invalid_union');
  if (!isKnownType) return null;
  throw result.error;
}
