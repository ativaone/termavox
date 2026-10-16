import { getAuthRuntime } from '../../../lib/auth/server.ts';
import { getLayoutResponse, putLayoutResponse } from '../../../lib/layout-api.ts';

// The signed-in user's workspace layout (plan §8.2): GET, and PUT with If-Match → 409 on a stale
// version. Other methods get 405.
export function GET(request: Request): Promise<Response> {
  return getLayoutResponse(getAuthRuntime(), request);
}

export function PUT(request: Request): Promise<Response> {
  return putLayoutResponse(getAuthRuntime(), request);
}
