import { getAuthRuntime } from '../../../../lib/auth/server.ts';
import { issueWsTicket } from '../../../../lib/ws-ticket.ts';

// POST only (other methods get 405): issues a WebSocket ticket for session-manager (plan §7.1).
export function POST(request: Request): Promise<Response> {
  return issueWsTicket(getAuthRuntime(), request);
}
