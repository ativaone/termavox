import './server-guard.ts';
import { signTicket, TICKET_TTL_MS } from '@termdock/protocol';
import { ErrorCode } from '@termdock/shared';
import { authGate } from './auth/gate.ts';
import type { AuthRuntime } from './auth/runtime.ts';

type TicketDeps = Pick<AuthRuntime, 'auth' | 'db' | 'publicOrigin' | 'wsSecret'>;

/**
 * `POST /api/ws/ticket` (plan §7.1). Requires `Origin` to equal TERMDOCK_PUBLIC_URL's origin and
 * an auth session that passes the gate: no session or a disabled account → 401, a pending
 * password change or TOTP enrollment → 403. Returns a 30 s single-use ticket bound to the user
 * and the auth session, signed with the key session-manager verifies.
 */
export async function issueWsTicket(
  deps: TicketDeps,
  request: Request,
  now: number = Date.now(),
): Promise<Response> {
  if (request.headers.get('origin') !== deps.publicOrigin) {
    return reply(403, { code: ErrorCode.Forbidden, message: 'origin not allowed' });
  }
  const gate = await authGate(deps, request.headers);
  if (!gate.ok) {
    if (gate.reason === 'password-change' || gate.reason === 'totp-enrollment') {
      return reply(403, { code: ErrorCode.Forbidden, message: `pending ${gate.reason}` });
    }
    return reply(401, { code: ErrorCode.Unauthenticated, message: 'authentication required' });
  }
  const ticket = signTicket(deps.wsSecret, { uid: gate.user.id, asid: gate.session.id }, now);
  return reply(200, { ticket, expiresAt: now + TICKET_TTL_MS });
}

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
