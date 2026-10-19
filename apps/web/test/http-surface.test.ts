import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serveAuthRequest } from '../lib/auth/http-surface.ts';
import {
  createUser,
  type Jar,
  makeRuntime,
  PUBLIC_URL,
  signIn,
  type TestRuntime,
} from './helpers.ts';

let t: TestRuntime;
let jar: Jar;

beforeAll(async () => {
  t = makeRuntime();
  await createUser(t.rt, 'alice');
  ({ jar } = await signIn(t.rt, 'alice'));
});
afterAll(() => t.cleanup());

function request(method: 'GET' | 'POST', path: string): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method,
    headers: jar.headers({ origin: PUBLIC_URL, 'content-type': 'application/json' }),
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

describe('Better Auth HTTP allowlist (/api/auth/[...all])', () => {
  it('hands GET /api/auth/get-session to Better Auth, query string included', async () => {
    const res = await serveAuthRequest(request('GET', '/api/auth/get-session'), (req) =>
      t.rt.auth.handler(req),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { username: 'alice' } });

    const handler = vi.fn(async () => new Response('ok'));
    await serveAuthRequest(
      request('GET', '/api/auth/get-session?disableCookieCache=true'),
      handler,
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    ['POST', '/api/auth/is-username-available'],
    ['POST', '/api/auth/update-user'],
    ['POST', '/api/auth/admin/set-role'],
    ['POST', '/api/auth/admin/remove-user'],
    ['POST', '/api/auth/admin/list-user-sessions'],
    ['POST', '/api/auth/sign-in/username'],
    ['POST', '/api/auth/get-session'],
    ['GET', '/api/auth/get-session/'],
    ['GET', '/api/auth/%67et-session'],
    ['GET', '/api/auth//get-session'],
    ['GET', '/api/auth/Get-Session'],
    ['GET', '/api/auth/list-sessions'],
  ] as const)('answers %s %s with 404 without calling Better Auth', async (method, path) => {
    const handler = vi.fn((req: Request) => t.rt.auth.handler(req));
    const res = await serveAuthRequest(request(method, path), handler);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
    expect(handler).not.toHaveBeenCalled();
  });
});
