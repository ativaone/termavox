import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UpdateSessionRequest } from '@termavox/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InternalApiClient, InternalApiError, isInternalApiError } from '../lib/internal-api.ts';

const SOCKET = 'tv-a1b2c3d4-abcdefghijk2';
const LISTED = {
  error: null,
  sessions: [
    {
      socket: SOCKET,
      origin: 'other',
      sessionId: null,
      label: null,
      createdAt: 1_700_000_000_000,
      lastActivityAt: null,
      attachedClients: 1,
    },
  ],
  cleaned: 2,
  truncated: false,
};

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
      // Remote tmux leftovers (plan D-30) and End all sessions; `slow` answers after 300 ms.
      const later = (fn: () => void) => (path.includes('slow') ? setTimeout(fn, 300) : fn());
      if (path.endsWith('/sessions/terminate-all')) {
        return setTimeout(() => send(200, { terminated: 3 }), 300);
      }
      // Stop (plan D-31) and removal (plan D-32): `live` is not retrying, nor ended.
      if (path.endsWith('/sessions/remove-ended')) return send(200, { removed: 4 });
      if (path.endsWith('/stop') || req.method === 'DELETE') {
        if (path.includes('/live')) {
          return send(409, { code: 'CONFLICT', message: 'the session is not retrying' });
        }
        if (path.includes('/sessions/')) return send(204);
      }
      if (path.endsWith('/remote-sessions')) {
        if (path.includes('/odd/')) {
          // A name read from the host that is not a Termavox socket: never passed on.
          const bad = { ...LISTED.sessions[0], socket: 'tv-x; rm -rf /' };
          return send(200, { ...LISTED, sessions: [bad] });
        }
        return later(() => send(200, LISTED));
      }
      if (path.endsWith('/remote-sessions/terminate')) {
        return send(200, { terminated: !path.includes('/gone/') });
      }
      if (path.endsWith('/remote-sessions/adopt')) {
        if (path.includes('/busy/')) {
          return send(409, { code: 'CONFLICT', message: 'that tmux server runs in Termavox' });
        }
        return later(() => send(201, { sessionId: 'adopted-1' }));
      }
      if (path.endsWith('/credentials/missing')) {
        return send(404, { code: 'NOT_FOUND', message: 'credential not found' });
      }
      if (path.endsWith('/credentials/busy')) {
        return send(409, { code: 'CONFLICT', message: 'credential is used by a session' });
      }
      if (path.endsWith('/credentials/ok')) return send(204);
      if (req.method === 'PATCH' && path.includes('/sessions/')) {
        const { label, notify } = JSON.parse(body) as { label?: string; notify?: boolean };
        if (label !== undefined && !label.trim()) {
          return send(400, { code: 'LABEL_INVALID', message: 'label must be …' });
        }
        return send(200, {
          sessionId: decodeURIComponent(path.split('/').at(-1)!),
          label: label?.trim() ?? 'stored',
          notify: notify ?? false,
        });
      }
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

  it('renames a session with PATCH and returns the stored label; LABEL_INVALID stays a 400 code', async () => {
    await expect(client().renameSession('s/1', 'user-1', ' build box ')).resolves.toEqual({
      sessionId: 's/1',
      label: 'build box',
      notify: false,
    });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: 'PATCH', url: '/internal/v1/sessions/s%2F1' });
    expect(JSON.parse(last.body)).toEqual({ actingUserId: 'user-1', label: ' build box ' });
    const blank = await failure(client().renameSession('s-1', 'user-1', '   '));
    expect(blank).toMatchObject({ kind: 'bad_request', status: 400, code: 'LABEL_INVALID' });
  });

  it('sets the desktop notification flag with the same PATCH, carrying only the flag', async () => {
    await expect(client().setSessionNotify('s-1', 'user-1', true)).resolves.toEqual({
      sessionId: 's-1',
      label: 'stored',
      notify: true,
    });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: 'PATCH', url: '/internal/v1/sessions/s-1' });
    expect(JSON.parse(last.body)).toEqual({ actingUserId: 'user-1', notify: true });
    // Neither field never leaves web: the request schema needs one of them.
    const before = seen.length;
    expect(() => UpdateSessionRequest.parse({ actingUserId: 'user-1' })).toThrow(
      /label or notify is required/,
    );
    expect(seen).toHaveLength(before);
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

  it('recognizes the error class of another bundle layer by its shape', () => {
    const otherCopy = Object.assign(new Error('busy'), {
      name: 'InternalApiError',
      kind: 'conflict',
      status: 409,
      code: 'CONFLICT',
    });
    expect(otherCopy instanceof InternalApiError).toBe(false);
    expect(isInternalApiError(otherCopy)).toBe(true);
    expect(isInternalApiError(new InternalApiError('timeout', 0, 'TIMEOUT', 'slow'))).toBe(true);
    expect(isInternalApiError(Object.assign(new Error('x'), { name: 'InternalApiError' }))).toBe(
      false,
    );
    expect(isInternalApiError(new Error('boom'))).toBe(false);
  });
});

describe('Stop and removal (plans D-31, D-32)', () => {
  it('stops a session, removes one or every ended session, and maps a refusal to CONFLICT', async () => {
    await expect(client().stopSession('s/1', 'user-1')).resolves.toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/internal/v1/sessions/s%2F1/stop' });
    await expect(client().removeSession('s/1', 'user-1')).resolves.toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: '/internal/v1/sessions/s%2F1' });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ actingUserId: 'user-1' });
    await expect(client().removeEndedSessions('user-1')).resolves.toEqual({ removed: 4 });
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/internal/v1/sessions/remove-ended',
    });
    expect(await failure(client().stopSession('live', 'user-1'))).toMatchObject({
      kind: 'conflict',
      code: 'CONFLICT',
    });
    expect(await failure(client().removeSession('live', 'user-1'))).toMatchObject({
      kind: 'conflict',
    });
  });
});

describe('remote tmux leftovers and End all sessions (plan D-30)', () => {
  const body = () => JSON.parse(seen.at(-1)!.body) as unknown;

  it('lists remote sessions within the SSH budget, not the default one', async () => {
    const patient = new InternalApiClient({
      baseUrl: base,
      token: TOKEN,
      timeoutMs: 50,
      serverTestTimeoutMs: 2_000,
    });
    await expect(patient.listRemoteSessions('slow', 'user-1')).resolves.toEqual(LISTED);
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/internal/v1/servers/slow/remote-sessions',
    });
    expect(body()).toEqual({ actingUserId: 'user-1' });

    const hasty = new InternalApiClient({ baseUrl: base, token: TOKEN, serverTestTimeoutMs: 50 });
    const late = await failure(hasty.listRemoteSessions('slow', 'user-1'));
    expect(late).toMatchObject({ kind: 'timeout', status: 0 });
  });

  it('refuses a listing whose socket names are not Termavox sockets', async () => {
    const odd = await failure(client().listRemoteSessions('odd', 'user-1'));
    expect(odd).toMatchObject({ kind: 'bad_response', status: 200 });
  });

  it('ends one remote session; a malformed socket never leaves', async () => {
    await expect(client().terminateRemoteSession('srv/1', SOCKET, 'user-1')).resolves.toEqual({
      terminated: true,
    });
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/internal/v1/servers/srv%2F1/remote-sessions/terminate',
    });
    expect(body()).toEqual({ actingUserId: 'user-1', socket: SOCKET });
    await expect(client().terminateRemoteSession('gone', SOCKET, 'user-1')).resolves.toEqual({
      terminated: false,
    });

    const before = seen.length;
    const invalid = await failure(client().terminateRemoteSession('srv', 'tv-../x', 'user-1'));
    expect(invalid).toMatchObject({ kind: 'bad_request', status: 0, code: 'BAD_REQUEST' });
    expect(seen.length).toBe(before);
  });

  it('adopts a remote session, with the label only when given, within the SSH budget', async () => {
    const patient = new InternalApiClient({
      baseUrl: base,
      token: TOKEN,
      timeoutMs: 50,
      serverTestTimeoutMs: 2_000,
    });
    await expect(patient.adoptRemoteSession('slow', SOCKET, 'user-1')).resolves.toEqual({
      sessionId: 'adopted-1',
    });
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/internal/v1/servers/slow/remote-sessions/adopt',
    });
    expect(body()).toEqual({ actingUserId: 'user-1', socket: SOCKET });

    await client().adoptRemoteSession('srv', SOCKET, 'user-1', 'old build');
    expect(body()).toEqual({ actingUserId: 'user-1', socket: SOCKET, label: 'old build' });

    const busy = await failure(client().adoptRemoteSession('busy', SOCKET, 'user-1'));
    expect(busy).toMatchObject({ kind: 'conflict', status: 409, code: 'CONFLICT' });
  });

  it('ends all sessions with its own budget, longer than the default', async () => {
    const hasty = client(TOKEN, 50);
    await expect(hasty.terminateAllSessions('user-1')).resolves.toEqual({ terminated: 3 });
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/internal/v1/sessions/terminate-all',
    });
    expect(body()).toEqual({ actingUserId: 'user-1' });
  });
});
