import { serveAuthRequest } from '../../../../lib/auth/http-surface.ts';
import { getAuthRuntime } from '../../../../lib/auth/server.ts';

// Better Auth over HTTP: only lib/auth/http-surface.ts's allowlist (the workspace's session
// keep-alive) reaches its handler; every other request answers 404. The runtime is resolved per
// allowed request, so building the app needs no secrets.
export function GET(request: Request): Promise<Response> {
  return serveAuthRequest(request, (req) => getAuthRuntime().auth.handler(req));
}

export function POST(request: Request): Promise<Response> {
  return serveAuthRequest(request, (req) => getAuthRuntime().auth.handler(req));
}
