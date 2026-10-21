import { uuidv7 } from '@termavox/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalApiClient } from '../lib/internal-api.ts';
import { CONNECT_CODES, connectCodeKey } from '../lib/manage/connect-codes.ts';
import { createServer, type ServerInput } from '../lib/repo/servers.ts';
import { createUser, makeRuntime, type TestRuntime } from './helpers.ts';

// The Server Actions (lib/actions/remote-sessions.ts, terminateAllSessions) run against these
// stand-ins for Next; the daemon is a fake fetch behind the real internal API client.
const next = vi.hoisted(() => ({
  user: { id: '', role: 'user' as string | null },
  rt: null as unknown,
  revalidated: [] as string[],
}));
vi.mock('../lib/auth/server.ts', () => ({
  requireSession: async () => ({ user: next.user, session: {} }),
  getAuthRuntime: () => next.rt,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}.${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => next.revalidated.push(path),
}));

const { adoptRemoteSession, listRemoteSessions, terminateRemoteSession } = await import(
  '../lib/actions/remote-sessions.ts'
);
const { terminateAllSessions } = await import('../lib/actions/sessions.ts');

const SOCKET = 'tv-a1b2c3d4-abcdefghijk2';

interface Call {
  path: string;
  body: Record<string, unknown>;
}
const calls: Call[] = [];
/** The daemon's answer per path suffix: [status, body]. */
let answers: Record<string, [number, unknown]> = {};

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace('/internal/v1', '');
  calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
  const key = Object.keys(answers).find((suffix) => path.endsWith(suffix));
  const [status, body] = key ? answers[key]! : [404, { code: 'NOT_FOUND', message: 'no route' }];
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const SERVER: ServerInput = {
  name: 'build box',
  kind: 'ssh',
  hostname: 'build.internal',
  port: 2222,
  username: 'ops',
  credentialId: null,
  protectionMode: 'auto',
  tmuxTerm: 'auto',
  startupCommand: null,
  env: {},
  keepaliveIntervalS: 15,
  autoReopen: true,
  scrollbackLines: 5000,
};

let t: TestRuntime;
let alice: string;
let bob: string;
/** Alice's server with a stored credential and a trusted host key. */
let ready: string;
/** Alice's server at another address: no trusted key, no credential. */
let bare: string;
/** Alice's server with a trusted key but no credential. */
let keyOnly: string;
let local: string;

function insertCredential(userId: string): string {
  const id = uuidv7();
  t.rt.db.$client
    .prepare(
      `INSERT INTO credentials (id, user_id, name, kind, ciphertext, nonce, key_version, created_at)
       VALUES (?, ?, 'key', 'private_key', ?, ?, 1, ?)`,
    )
    .run(id, userId, Buffer.alloc(16), Buffer.alloc(12), Date.now());
  return id;
}

function trustKey(userId: string, hostname: string, port: number): void {
  t.rt.db.$client
    .prepare(
      `INSERT INTO known_host_keys
         (id, user_id, hostname, port, key_type, fingerprint_sha256, status, first_seen_at)
       VALUES (?, ?, ?, ?, 'ssh-ed25519', ?, 'trusted', ?)`,
    )
    .run(uuidv7(), userId, hostname, port, `SHA256:${'A'.repeat(43)}`, Date.now());
}

function create(userId: string, input: Partial<ServerInput>): string {
  const created = createServer(t.rt.db, userId, { ...SERVER, ...input });
  if (created.outcome !== 'ok') throw new Error(created.outcome);
  return created.id;
}

beforeAll(async () => {
  t = makeRuntime();
  alice = (await createUser(t.rt, 'alice')).id;
  bob = (await createUser(t.rt, 'bob')).id;
  next.rt = t.rt;
  ready = create(alice, { credentialId: insertCredential(alice) });
  trustKey(alice, SERVER.hostname!, SERVER.port!);
  bare = create(alice, { name: 'bare', hostname: 'bare.internal' });
  keyOnly = create(alice, { name: 'key only' });
  local = create(alice, {
    name: 'local',
    kind: 'local',
    hostname: null,
    port: null,
    username: null,
  });
  (globalThis as { __termavoxInternalApi?: InternalApiClient }).__termavoxInternalApi =
    new InternalApiClient({ baseUrl: 'http://daemon.test', token: 'token', fetch: fakeFetch });
});
afterAll(() => {
  delete (globalThis as { __termavoxInternalApi?: InternalApiClient }).__termavoxInternalApi;
  t.cleanup();
});
beforeEach(() => {
  next.user = { id: alice, role: 'user' };
  next.revalidated = [];
  calls.length = 0;
  answers = {};
});

describe('connection codes on the server page', () => {
  it('words the known codes and folds anything else into OTHER', () => {
    for (const code of CONNECT_CODES) expect(connectCodeKey(code)).toBe(code);
    expect(connectCodeKey('INTERNAL')).toBe('OTHER');
    expect(connectCodeKey('')).toBe('OTHER');
    expect(connectCodeKey(null)).toBe('OTHER');
  });
});

describe('Check now (listRemoteSessions)', () => {
  const listed = {
    socket: SOCKET,
    origin: 'unknown',
    sessionId: null,
    label: null,
    createdAt: null,
    lastActivityAt: 1_700_000_000_000,
    attachedClients: 0,
  };

  it('asks the daemon as the signed-in user and passes the listing on', async () => {
    answers['/remote-sessions'] = [
      200,
      { error: null, sessions: [listed], cleaned: 1, truncated: true },
    ];
    const result = await listRemoteSessions(ready);
    expect(result).toMatchObject({ ok: true, sessions: [listed], cleaned: 1, truncated: true });
    expect(result.ok && typeof result.at).toBe('number');
    expect(calls).toEqual([
      { path: `/servers/${ready}/remote-sessions`, body: { actingUserId: alice } },
    ]);
  });

  it("never reaches the daemon for another user's server, a local one or a malformed id", async () => {
    next.user = { id: bob, role: 'user' };
    expect(await listRemoteSessions(ready)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'servers.diagnostics.error.notFound',
    });
    next.user = { id: alice, role: 'user' };
    expect(await listRemoteSessions(local)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await listRemoteSessions('x'.repeat(65))).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
      message: 'servers.diagnostics.error.rejected',
    });
    expect(calls).toEqual([]);
  });

  it('explains a check that could not sign in by its likely cause', async () => {
    answers['/remote-sessions'] = [
      200,
      { error: 'AUTH_REJECTED', sessions: [], cleaned: 0, truncated: false },
    ];
    // No trusted host key for the address: the daemon never asks, so trusting comes first.
    expect(await listRemoteSessions(bare)).toEqual({
      ok: false,
      code: 'AUTH_REJECTED',
      message: 'servers.remote.error.untrusted',
    });
    // A trusted key but no stored credential: it cannot sign in without a password prompt.
    expect(await listRemoteSessions(keyOnly)).toMatchObject({
      message: 'servers.remote.error.noCredential',
    });
    // Both in place: the code's own wording.
    expect(await listRemoteSessions(ready)).toMatchObject({
      message: 'servers.diagnostics.code.AUTH_REJECTED',
    });
    // The daemon contacted nothing: the server has no credential to sign in with.
    answers['/remote-sessions'] = [
      200,
      { error: 'CREDENTIAL_REQUIRED', sessions: [], cleaned: 0, truncated: false },
    ];
    expect(await listRemoteSessions(bare)).toMatchObject({
      code: 'CREDENTIAL_REQUIRED',
      message: 'servers.remote.error.noCredential',
    });
    // Refused before any sign-in: said as such, whatever else is missing.
    answers['/remote-sessions'] = [
      200,
      { error: 'HOST_UNREACHABLE', sessions: [], cleaned: 0, truncated: false },
    ];
    expect(await listRemoteSessions(bare)).toMatchObject({
      code: 'HOST_UNREACHABLE',
      message: 'servers.diagnostics.code.HOST_UNREACHABLE',
    });
    answers['/remote-sessions'] = [
      200,
      { error: 'SOMETHING_NEW', sessions: [], cleaned: 0, truncated: false },
    ];
    expect(await listRemoteSessions(ready)).toMatchObject({
      code: 'SOMETHING_NEW',
      message: 'servers.diagnostics.code.OTHER',
    });
  });

  it('maps service failures: rate limit, unreachable daemon, malformed answer', async () => {
    answers['/remote-sessions'] = [429, { code: 'RATE_LIMITED', message: 'slow down' }];
    expect(await listRemoteSessions(ready)).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      message: 'servers.diagnostics.error.testLimit',
    });
    answers['/remote-sessions'] = [200, { error: null, sessions: [{ socket: 'tmux-0' }] }];
    expect(await listRemoteSessions(ready)).toEqual({
      ok: false,
      code: 'BAD_RESPONSE',
      message: 'servers.diagnostics.error.generic',
    });
    answers['/remote-sessions'] = [503, { code: 'UNAVAILABLE', message: 'later' }];
    expect(await listRemoteSessions(ready)).toMatchObject({
      message: 'servers.diagnostics.error.generic',
    });
  });
});

describe('End (terminateRemoteSession)', () => {
  it('ends a listed session and says whether it was still there', async () => {
    answers['/remote-sessions/terminate'] = [200, { terminated: true }];
    expect(await terminateRemoteSession(ready, SOCKET)).toEqual({ ok: true, terminated: true });
    expect(calls.at(-1)).toEqual({
      path: `/servers/${ready}/remote-sessions/terminate`,
      body: { actingUserId: alice, socket: SOCKET },
    });
    answers['/remote-sessions/terminate'] = [200, { terminated: false }];
    expect(await terminateRemoteSession(ready, SOCKET)).toEqual({ ok: true, terminated: false });
  });

  it('refuses a malformed socket name before asking the daemon', async () => {
    for (const socket of ['tv-abc', 'tv-a1b2c3d4-ABCDEFGHIJK2', `${SOCKET}\n`, 'default']) {
      expect(await terminateRemoteSession(ready, socket)).toMatchObject({
        ok: false,
        code: 'BAD_REQUEST',
      });
    }
    expect(calls).toEqual([]);
  });

  it('says a session that runs in Termavox is not ended here, and words connection codes', async () => {
    answers['/remote-sessions/terminate'] = [409, { code: 'CONFLICT', message: 'running' }];
    expect(await terminateRemoteSession(ready, SOCKET)).toEqual({
      ok: false,
      code: 'CONFLICT',
      message: 'servers.remote.error.running',
    });
    answers['/remote-sessions/terminate'] = [502, { code: 'HOST_UNREACHABLE', message: 'no' }];
    expect(await terminateRemoteSession(ready, SOCKET)).toEqual({
      ok: false,
      code: 'HOST_UNREACHABLE',
      message: 'servers.diagnostics.code.HOST_UNREACHABLE',
    });
    answers['/remote-sessions/terminate'] = [502, { code: 'AUTH_REJECTED', message: 'no' }];
    expect(await terminateRemoteSession(bare, SOCKET)).toMatchObject({
      message: 'servers.remote.error.untrusted',
    });
  });
});

describe('Adopt (adoptRemoteSession)', () => {
  it('opens a new session of the server attached to it, keeping a given name', async () => {
    answers['/remote-sessions/adopt'] = [201, { sessionId: 'adopted-1' }];
    expect(await adoptRemoteSession(ready, SOCKET, 'old build')).toEqual({
      ok: true,
      sessionId: 'adopted-1',
    });
    expect(calls.at(-1)).toEqual({
      path: `/servers/${ready}/remote-sessions/adopt`,
      body: { actingUserId: alice, socket: SOCKET, label: 'old build' },
    });
    // Blank or absent: the daemon names it after the server.
    await adoptRemoteSession(ready, SOCKET, '   ');
    expect(calls.at(-1)?.body).toEqual({ actingUserId: alice, socket: SOCKET });
    expect(next.revalidated).toContain(`/servers/${ready}`);
  });

  it('validates its input and maps the session cap and conflicts', async () => {
    expect(await adoptRemoteSession(ready, SOCKET, 'x'.repeat(1025))).toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await adoptRemoteSession(ready, 'tv-..')).toMatchObject({ code: 'BAD_REQUEST' });
    expect(calls).toEqual([]);
    answers['/remote-sessions/adopt'] = [429, { code: 'RATE_LIMITED', message: 'cap' }];
    expect(await adoptRemoteSession(ready, SOCKET)).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      message: 'manage.sessionError.limit',
    });
    answers['/remote-sessions/adopt'] = [409, { code: 'CONFLICT', message: 'running' }];
    expect(await adoptRemoteSession(ready, SOCKET)).toMatchObject({
      message: 'servers.remote.error.running',
    });
    answers['/remote-sessions/adopt'] = [400, { code: 'LABEL_INVALID', message: 'label' }];
    expect(await adoptRemoteSession(ready, SOCKET, '​')).toMatchObject({
      code: 'LABEL_INVALID',
      message: 'manage.sessionError.labelInvalid',
    });
  });
});

describe('End all sessions (terminateAllSessions)', () => {
  it('ends every session of the signed-in user and reports how many', async () => {
    answers['/sessions/terminate-all'] = [200, { terminated: 4 }];
    expect(await terminateAllSessions()).toEqual({ ok: true, terminated: 4 });
    expect(calls).toEqual([{ path: '/sessions/terminate-all', body: { actingUserId: alice } }]);
  });

  it('words a refusal or an unanswered call', async () => {
    answers['/sessions/terminate-all'] = [403, { code: 'FORBIDDEN', message: 'disabled' }];
    expect(await terminateAllSessions()).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: 'manage.sessionError.forbidden',
    });
    answers['/sessions/terminate-all'] = [200, { terminated: -1 }];
    expect(await terminateAllSessions()).toMatchObject({
      code: 'BAD_RESPONSE',
      message: 'manage.sessionError.generic',
    });
  });
});
