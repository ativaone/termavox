// Liveness probe for the compose healthcheck (plan §13.5): no auth, no database access.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
