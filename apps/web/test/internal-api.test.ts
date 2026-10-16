import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InternalApiClient, InternalApiError } from '../lib/internal-api.ts';

const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
let server: Server;
let base: string;

beforeAll(async () => {
  // A stand-in for session-manager: answers by path, like the real internal API.
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (status: number, json?: unknown) => {
        res.statusCode = status;
        if (json !== undefined) res.setHeader('content-type', 'application/json');
        res.end(json === undefined ? undefined : JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return send(401, { code: 'UNAUTHENTICATED', message: 'missing or invalid bearer token' });
      }
      const path = req.url ?? '';
      if (path.endsWith('/credentials/missing')) {
        return send(404, { code: 'NOT_FOUND', message: 'credential not found' });
      }
      if (path.endsWith('/credentials/busy')) {
        return send(409, { code: 'CONFLICT', message: 'credential is used by a session' });
      }
      if (path.endsWith('/credentials/ok')) return send(204);
      if (path.endsWith('/credentials')) return send(201, { credentialId: 42 });
      if (path.endsWith('/health')) {
        return setTimeout(
          () => send(200, { ok: true, sessions: 0, uptimeMs: 1, version: 't' }),
          300,
        );
      }
      return send(404, { code: 'NOT_FOUND', message: 'no such route' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const client = (token = TOKEN, timeoutMs = 2_000) =>
  new InternalApiClient({ baseUrl: base, token, timeoutMs });

async function failure(promise: Promise<unknown>): Promise<InternalApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InternalApiError);
  return err as InternalApiError;
}

describe('internal API client error mapping', () => {
  it('maps 401 / 404 / 409 to typed errors and sends the bearer and acting user', async () => {
    const denied = await failure(client('wrong-token').deleteCredential('ok', 'user-1'));
    expect(denied).toMatchObject({ kind: 'unauthorized', status: 401, code: 'UNAUTHENTICATED' });

    const missing = await failure(client().deleteCredential('missing', 'user-1'));
    expect(missing).toMatchObject({ kind: 'not_found', status: 404, code: 'NOT_FOUND' });

    const busy = await failure(client().deleteCredential('busy', 'user-1'));
    expect(busy).toMatchObject({ kind: 'conflict', status: 409, code: 'CONFLICT' });
    expect(busy.message).toBe('credential is used by a session');

    await expect(client().deleteCredential('ok', 'user-1')).resolves.toBeUndefined();
    const last = seen.at(-1)!;
    expect(last).toMatchObject({
      method: 'DELETE',
      url: '/internal/v1/credentials/ok',
      auth: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(last.body)).toEqual({ actingUserId: 'user-1' });
  });

  it('rejects malformed answers, unreachable and slow services, without echoing secrets', async () => {
    const odd = await failure(
      client().createCredential({
        actingUserId: 'user-1',
        kind: 'password',
        name: 'db',
        password: 'super-secret-password',
      }),
    );
    expect(odd).toMatchObject({ kind: 'bad_response', status: 201 });
    expect(JSON.stringify({ ...odd, message: odd.message })).not.toContain('super-secret');

    const invalid = await failure(
      client().createCredential({
        actingUserId: '',
        kind: 'password',
        name: 'db',
        password: 'super-secret-password',
      }),
    );
    expect(invalid).toMatchObject({ kind: 'bad_request', status: 0 });
    expect(invalid.message).not.toContain('super-secret');

    const slow = await failure(client(TOKEN, 50).health());
    expect(slow).toMatchObject({ kind: 'timeout', status: 0 });

    const closed = new InternalApiClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN });
    expect(await failure(closed.health())).toMatchObject({ kind: 'unavailable', status: 0 });
  });
});
