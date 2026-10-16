import { getAuthRuntime } from '../../../../lib/auth/server.ts';

// Better Auth's endpoints (sign-in, two-factor, admin, session). The runtime is resolved per
// request, so building the app needs no secrets.
export function GET(request: Request): Promise<Response> {
  return getAuthRuntime().auth.handler(request);
}

export function POST(request: Request): Promise<Response> {
  return getAuthRuntime().auth.handler(request);
}
