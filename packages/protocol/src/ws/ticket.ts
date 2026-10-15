import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Short-lived, single-use WebSocket ticket issued by web, verified by session-manager. Plan §7.1. */
export const TICKET_TTL_MS = 30_000;

export const TicketPayload = z.object({
  v: z.literal(1),
  uid: z.string().min(1).max(64),
  asid: z.string().min(1).max(128),
  exp: z.number().int(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});
export type TicketPayload = z.infer<typeof TicketPayload>;

export type TicketError = 'malformed' | 'bad_signature' | 'expired' | 'replayed';

export function signTicket(
  secret: Uint8Array,
  claims: { uid: string; asid: string },
  now: number = Date.now(),
): string {
  const payload: TicketPayload = {
    v: 1,
    uid: claims.uid,
    asid: claims.asid,
    exp: now + TICKET_TTL_MS,
    nonce: randomBytes(16).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(secret, body)}`;
}

/**
 * Verifies signature, expiry and single use. `nonces` must be shared by every verifier in the
 * process; a ticket is consumed only when it is otherwise valid.
 */
export function verifyTicket(
  secret: Uint8Array,
  ticket: string,
  nonces: NonceCache,
  now: number = Date.now(),
): { ok: true; payload: TicketPayload } | { ok: false; error: TicketError } {
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'malformed' };
  const [body, signature] = parts as [string, string];
  const expected = Buffer.from(mac(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, error: 'bad_signature' };
  }
  let payload: TicketPayload;
  try {
    payload = TicketPayload.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (payload.exp <= now || payload.exp > now + TICKET_TTL_MS * 2)
    return { ok: false, error: 'expired' };
  if (!nonces.consume(payload.nonce, payload.exp, now)) return { ok: false, error: 'replayed' };
  return { ok: true, payload };
}

function mac(secret: Uint8Array, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Remembers consumed nonces until their ticket expires. */
export class NonceCache {
  readonly #seen = new Map<string, number>();

  consume(nonce: string, exp: number, now: number = Date.now()): boolean {
    this.#sweep(now);
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, exp);
    return true;
  }

  #sweep(now: number): void {
    for (const [nonce, exp] of this.#seen) if (exp <= now) this.#seen.delete(nonce);
  }
}
