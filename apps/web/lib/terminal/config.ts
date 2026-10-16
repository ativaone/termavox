import type { WsTicket } from './types.ts';

export const TICKET_PATH = '/api/ws/ticket';
export const WS_PATH = '/ws';

/** The ticket endpoint answered with an HTTP error (401/403 are not retried). */
export class TicketRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`ticket request failed with HTTP ${status}`);
    this.name = 'TicketRequestError';
    this.status = status;
  }
}

/** Fetches a single-use ticket from the same origin (cookie-authenticated, plan §7.1). */
export async function fetchWsTicket(): Promise<WsTicket> {
  const res = await fetch(TICKET_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new TicketRequestError(res.status);
  const body = (await res.json()) as Partial<WsTicket>;
  if (typeof body.ticket !== 'string' || typeof body.expiresAt !== 'number') {
    throw new TicketRequestError(res.status);
  }
  return { ticket: body.ticket, expiresAt: body.expiresAt };
}

/** Dev override, e.g. `ws://localhost:3001/ws` when session-manager runs outside the proxy. */
function envWsUrl(): string | undefined {
  try {
    // Inlined by Next.js at build time; must stay a literal `process.env.NEXT_PUBLIC_*` access.
    return process.env.NEXT_PUBLIC_TERMDOCK_WS_URL || undefined;
  } catch {
    return undefined;
  }
}

/** The WebSocket URL: the explicit override, else NEXT_PUBLIC_TERMDOCK_WS_URL, else same-origin `/ws`. */
export function resolveWsUrl(
  override?: string,
  location: Pick<Location, 'protocol' | 'host'> | undefined = globalThis.location,
): string {
  const configured = override ?? envWsUrl();
  if (configured) return configured;
  if (!location) throw new Error('no WebSocket URL configured and no window.location');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${WS_PATH}`;
}
