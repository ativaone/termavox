// T0: the remote-session routes and "End all sessions" of the internal API (plan D-30), against
// the real SQLite stores and an in-process SSH host that answers the probe, the scan and the
// kill commands (the scan script itself runs on real tmux in test/tmux/remote-scan.int.test.ts).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TermdockDb } from '@termdock/db';
import { ListRemoteSessionsResponse, type SessionSummary } from '@termdock/protocol';
import { randomToken, uuidv7 } from '@termdock/shared';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmuxSocketName } from '../../src/core/driver-factory.ts';
import type { SessionRecord } from '../../src/core/types.ts';
import {
  killServerCommand,
  scanSocketsCommand,
  serverAnswersCommand,
} from '../../src/drivers/tmux-control/commands.ts';
import {
  InternalApi,
  REMOTE_SESSIONS_LIMIT,
  type SessionControl,
} from '../../src/internal-api/server.ts';
import { probeCommand } from '../../src/probe/index.ts';
import { SqliteOwnership } from '../../src/store/access.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import { SqliteHostKeyStore } from '../../src/store/host-key-store.ts';
import { SqliteSessionStore } from '../../src/store/session-store.ts';
import { parsePublicKeyLine, TargetPolicy } from '../../src/transport/ssh/index.ts';
import { CredentialService, VaultCredentialProvider } from '../../src/vault/credentials.ts';
import { insertServer, insertUser, type TempDb, tempDb, testVault } from '../store/fixture.ts';

const KEYS = fileURLToPath(new URL('../../../../test/sshd/keys/', import.meta.url));
const HOST_PRIVATE_KEY = readFileSync(`${KEYS}ssh_host_ed25519_key`);
const HOST_KEY = parsePublicKeyLine(readFileSync(`${KEYS}ssh_host_ed25519_key.pub`, 'utf8'));
const TOKEN = randomBytes(32).toString('base64url');
const INSTALLATION_ID = '0190f2b1-7c3a-7d4e-8f00-123456789abc';
const PASSWORD = 'remote-secret';
const TMUX = '/usr/bin/tmux';
const PROBE = `shell=/bin/sh\ntmux_path=${TMUX}\ntmux_version=tmux 3.4\nutf8_locale=C.UTF-8\n`;
const own = (token: string): string => tmuxSocketName(INSTALLATION_ID, token);
const OTHER = 'td-zzzzzzzz-abcdefghijkl';

/** An SSH host that accepts one password and answers exec commands from a script. */
async function startHost(): Promise<{
  port: number;
  commands: string[];
  connections: number;
  answer: (command: string) => { stdout?: string; code: number };
  close(): Promise<void>;
}> {
  const clients = new Set<ssh2.Connection>();
  const host = {
    port: 0,
    commands: [] as string[],
    connections: 0,
    answer: (_command: string): { stdout?: string; code: number } => ({ code: 127 }),
    close: async () => {},
  };
  const server = new ssh2.Server({ hostKeys: [HOST_PRIVATE_KEY] }, (client) => {
    host.connections++;
    clients.add(client);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === PASSWORD) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          host.commands.push(info.command);
          const { stdout, code } = host.answer(info.command);
          if (stdout) stream.write(stdout);
          stream.exit(code);
          stream.end();
        });
      });
    });
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  host.port = (server.address() as AddressInfo).port;
  host.close = () =>
    new Promise<void>((resolve) => {
      for (const client of clients) client.end();
      server.close(() => resolve());
    });
  return host;
}

/** Registry stand-in: records creations and terminate-all calls. */
class FakeRegistry implements SessionControl {
  readonly created: SessionRecord[] = [];
  readonly terminatedAll: string[] = [];
  readonly store: SqliteSessionStore;
  constructor(store: SqliteSessionStore) {
    this.store = store;
  }
  create(record: SessionRecord): void {
    this.created.push(record);
  }
  async terminate() {}
  async terminateAll(userId: string) {
    this.terminatedAll.push(userId);
    return 3;
  }
  async retry() {}
  async stop() {}
  async remove() {}
  async removeEnded() {
    return 0;
  }
  async reopen(id: string) {
    return { sessionId: id };
  }
  async renamed() {}
  listForUser(userId: string): Promise<SessionSummary[]> {
    return this.store.listForUser(userId);
  }
  host() {
    return undefined;
  }
  get size() {
    return this.created.length;
  }
}

let fixture: TempDb;
let host: Awaited<ReturnType<typeof startHost>>;
let api: InternalApi;
let base: string;
let registry: FakeRegistry;
let writer: BatchedWriter;
let hostKeys: SqliteHostKeyStore;
let credentials: CredentialService;
let clock: { now: number };
let userA: string;
let userB: string;
/** userA's server at the in-process host, with a stored password credential. */
let serverA: string;

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${base}/internal/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  fixture = tempDb();
  const { db } = fixture;
  writer = new BatchedWriter(db);
  const vault = testVault();
  const sessions = new SqliteSessionStore(db, writer);
  credentials = new CredentialService({ db, writer, vault });
  registry = new FakeRegistry(sessions);
  hostKeys = new SqliteHostKeyStore(db, writer);
  host = await startHost();
  clock = { now: Date.now() };
  api = new InternalApi({
    host: '127.0.0.1',
    port: 0,
    token: new TextEncoder().encode(TOKEN),
    db,
    sessions,
    hostKeys,
    credentials,
    credentialProvider: new VaultCredentialProvider({ db, writer, vault }),
    ownership: new SqliteOwnership(db),
    registry,
    connections: { revoke: () => 0 },
    enableLocalShell: false,
    // The in-process host listens on loopback.
    targetPolicy: new TargetPolicy({ allowLocalTargets: true, localAddresses: () => [] }),
    installationId: INSTALLATION_ID,
    version: 'test',
    remoteSessions: { readyTimeoutMs: 5_000 },
    now: () => clock.now,
  });
  base = `http://127.0.0.1:${(await api.listen()).port}`;
  userA = insertUser(db);
  userB = insertUser(db);
  const { credentialId } = await credentials.create({
    actingUserId: userA,
    kind: 'password',
    name: 'pw',
    password: PASSWORD,
  });
  serverA = insertServer(db, userA, { name: 'web box', port: host.port, credentialId });
  await hostKeys.trust(
    { userId: userA, hostname: '127.0.0.1', port: host.port, serverId: serverA },
    {
      fingerprint: HOST_KEY.fingerprint,
      keyType: HOST_KEY.type,
      decidedBy: userA,
      allowPreTrust: true,
    },
  );
});

afterEach(async () => {
  await api.close();
  await host.close();
  await writer.close(1_000);
  fixture.cleanup();
});

/** A session row as session-manager writes them (state, end, socket) for the classification. */
function insertSession(
  db: TermdockDb,
  opts: {
    userId: string;
    serverId: string | null;
    token?: string;
    state?: string;
    endedAt?: number | null;
    tmuxSocket?: string | null;
    label?: string;
  },
): { id: string; token: string } {
  const id = uuidv7();
  const token = opts.token ?? randomToken(12);
  const state = opts.state ?? 'ready';
  db.$client
    .prepare(
      `INSERT INTO sessions (id, user_id, server_id, target_kind, target_hostname, target_port,
         target_username, term, scrollback_lines, label, desired_state, state, status,
         protection_effective, tmux_token, tmux_socket, cols, rows, created_at, ended_at, end_reason)
       VALUES (?, ?, ?, 'ssh', '127.0.0.1', ?, 'td', 'xterm-256color', 1000, ?, ?, ?, ?,
         'tmux-control', ?, ?, 80, 24, ?, ?, ?)`,
    )
    .run(
      id,
      opts.userId,
      opts.serverId,
      host.port,
      opts.label ?? 'a session',
      state === 'ended' ? 'terminated' : 'running',
      state,
      state === 'ended' ? 'ended' : 'connected',
      token,
      opts.tmuxSocket ?? null,
      Date.now(),
      opts.endedAt ?? null,
      state === 'ended' ? 'user_terminated' : null,
    );
  return { id, token };
}

/** The host answers the probe, the scan with `lines`, answers/kills per socket. */
function script(
  lines: string[],
  opts: { answers?: (socket: string) => number; kill?: (socket: string) => number } = {},
): { killed: string[] } {
  const killed: string[] = [];
  host.answer = (command) => {
    if (command === probeCommand()) return { stdout: PROBE, code: 0 };
    if (command === scanSocketsCommand({ tmuxPath: TMUX })) {
      return { stdout: lines.map((l) => `${l}\n`).join(''), code: 0 };
    }
    const socket = /(td-[a-z0-9]+-[a-z2-7]{12})/.exec(command)?.[1];
    if (socket && command === serverAnswersCommand({ tmuxPath: TMUX, socket })) {
      return { code: opts.answers?.(socket) ?? 0 };
    }
    if (socket && command === killServerCommand({ tmuxPath: TMUX, socket })) {
      killed.push(socket);
      return { code: opts.kill?.(socket) ?? 0 };
    }
    return { code: 127 };
  };
  return { killed };
}

const scanLine = (socket: string, attached = 0) => `${socket}\t1700000000\t1700000300\t${attached}`;

const events = (sessionId: string) =>
  (
    fixture.db.$client
      .prepare('SELECT type, detail_json FROM session_events WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as Array<{ type: string; detail_json: string | null }>
  ).map((e) => ({ type: e.type, detail: e.detail_json ? JSON.parse(e.detail_json) : null }));

const audits = (type: string) =>
  (
    fixture.db.$client
      .prepare(
        'SELECT actor_user_id, target_type, target_id, detail_json FROM audit_events WHERE type = ? ORDER BY rowid',
      )
      .all(type) as Array<Record<string, string>>
  ).map((r) => ({ ...r, detail_json: JSON.parse(r.detail_json!) }));

describe('POST /servers/:id/remote-sessions (list)', () => {
  it('ends my old leftovers, lists unknown, other and failed ones; hides Termdock and foreign sessions', async () => {
    const { db } = fixture;
    const minute = 60_000;
    const running = insertSession(db, { userId: userA, serverId: serverA });
    const theirsRunning = insertSession(db, { userId: userB, serverId: null });
    const theirsEnded = insertSession(db, {
      userId: userB,
      serverId: null,
      state: 'ended',
      endedAt: Date.now() - 10 * minute,
    });
    const leftover = insertSession(db, {
      userId: userA,
      serverId: serverA,
      state: 'ended',
      endedAt: Date.now() - 2 * minute,
      label: 'old build',
    });
    const recent = insertSession(db, {
      userId: userA,
      serverId: serverA,
      state: 'ended',
      endedAt: Date.now() - 10_000,
    });
    const stuck = insertSession(db, {
      userId: userA,
      serverId: serverA,
      state: 'ended',
      endedAt: Date.now() - 5 * minute,
      label: 'stuck one',
    });
    insertSession(db, { userId: userA, serverId: serverA, tmuxSocket: OTHER }); // adopted
    const unknownToken = randomToken(12);
    const otherInstall = 'td-qqqq9999-mnopqrstuvwx';
    const { killed } = script(
      [
        scanLine(own(running.token)),
        scanLine(own(theirsRunning.token)),
        scanLine(own(theirsEnded.token)),
        scanLine(own(leftover.token)),
        scanLine(own(recent.token)),
        scanLine(own(stuck.token), 1),
        scanLine(OTHER), // the adopted session's tmux server
        scanLine(own(unknownToken), 2),
        scanLine(otherInstall),
        'bash: warning: setlocale: LC_ALL: cannot change locale', // rc noise
      ],
      { kill: (socket) => (socket === own(stuck.token) ? 1 : 0) },
    );

    const listed = await call('POST', `/servers/${serverA}/remote-sessions`, {
      actingUserId: userA,
    });
    expect(listed.status).toBe(200);
    const body = ListRemoteSessionsResponse.parse(listed.json);
    expect(body).toEqual({
      error: null,
      cleaned: 1,
      truncated: false,
      sessions: [
        {
          socket: own(stuck.token),
          origin: 'ended',
          sessionId: stuck.id,
          label: 'stuck one',
          createdAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_300_000,
          attachedClients: 1,
        },
        {
          socket: own(unknownToken),
          origin: 'unknown',
          sessionId: null,
          label: null,
          createdAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_300_000,
          attachedClients: 2,
        },
        {
          socket: otherInstall,
          origin: 'other',
          sessionId: null,
          label: null,
          createdAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_300_000,
          attachedClients: 0,
        },
      ],
    });
    // Killed: my leftover ended 2 min ago, and the stuck one (its kill failed). Never the
    // running, foreign or recent ones.
    expect(killed.sort()).toEqual([own(leftover.token), own(stuck.token)].sort());
    await writer.flush();
    expect(events(leftover.id)).toEqual([{ type: 'remote_cleanup', detail: { source: 'scan' } }]);
    expect(events(stuck.id)).toEqual([]);
  });

  it('reports why it could not scan: no credential (nothing contacted), unknown host key (pending)', async () => {
    const { db } = fixture;
    const bare = insertServer(db, userA, { name: 'no credential', port: host.port });
    expect(await call('POST', `/servers/${bare}/remote-sessions`, { actingUserId: userA })).toEqual(
      {
        status: 200,
        json: { error: 'CREDENTIAL_REQUIRED', sessions: [], cleaned: 0, truncated: false },
      },
    );
    expect(host.connections).toBe(0);

    // userB at the very same address, with a credential: userA's trust does not apply (D-29).
    // The unknown key is recorded as pending for userB, like the server test does; no login.
    const { credentialId } = await credentials.create({
      actingUserId: userB,
      kind: 'password',
      name: 'pw',
      password: PASSWORD,
    });
    const theirs = insertServer(db, userB, { port: host.port, credentialId });
    const unknown = await call('POST', `/servers/${theirs}/remote-sessions`, {
      actingUserId: userB,
    });
    expect(unknown.json).toEqual({
      error: 'HOST_KEY_REJECTED',
      sessions: [],
      cleaned: 0,
      truncated: false,
    });
    expect(
      await hostKeys.list({ userId: userB, hostname: '127.0.0.1', port: host.port }),
    ).toMatchObject([{ status: 'pending', fingerprint: HOST_KEY.fingerprint }]);
    expect(host.commands).toEqual([]);
  });

  it('validates, checks ownership and limits calls per user', async () => {
    const { db } = fixture;
    expect((await call('POST', `/servers/${serverA}/remote-sessions`, {})).status).toBe(400);
    expect(
      (await call('POST', `/servers/${serverA}/remote-sessions`, { actingUserId: userB })).status,
    ).toBe(404);
    expect(
      (await call('POST', `/servers/${serverA}/remote-sessions`, { actingUserId: 'ghost' })).status,
    ).toBe(403);
    const local = insertServer(db, userA, { kind: 'local' });
    expect(
      (await call('POST', `/servers/${local}/remote-sessions`, { actingUserId: userA })).status,
    ).toBe(400);

    // Each list connects to the host: REMOTE_SESSIONS_LIMIT per user and minute.
    const bare = insertServer(db, userA, { port: host.port });
    const results: number[] = [];
    for (let i = 0; i < REMOTE_SESSIONS_LIMIT.max + 1; i++) {
      results.push(
        (await call('POST', `/servers/${bare}/remote-sessions`, { actingUserId: userA })).status,
      );
    }
    // The calls above (404/403/400 for userA's local server) took part of the budget too.
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(results.at(-1)).toBe(429);
    clock.now += REMOTE_SESSIONS_LIMIT.windowMs;
    expect(
      (await call('POST', `/servers/${bare}/remote-sessions`, { actingUserId: userA })).status,
    ).toBe(200);
  });
});

describe('POST /servers/:id/remote-sessions/terminate', () => {
  const terminate = (socket: string, actingUserId = userA, serverId = serverA) =>
    call('POST', `/servers/${serverId}/remote-sessions/terminate`, { actingUserId, socket });

  it('refuses Termdock and foreign sessions (409) without connecting', async () => {
    const { db } = fixture;
    const mine = insertSession(db, { userId: userA, serverId: serverA });
    const theirs = insertSession(db, { userId: userB, serverId: null });
    const theirsEnded = insertSession(db, {
      userId: userB,
      serverId: null,
      state: 'ended',
      endedAt: 1,
    });
    insertSession(db, { userId: userA, serverId: serverA, tmuxSocket: OTHER }); // adopted
    for (const socket of [own(mine.token), own(theirs.token), own(theirsEnded.token), OTHER]) {
      expect(await terminate(socket)).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
    }
    expect(host.connections).toBe(0);
    expect((await terminate('td-bad name')).status).toBe(400);
    expect((await terminate(own(randomToken(12)), userB)).status).toBe(404);
  });

  it('ends an unknown or other server and audits it; terminated false when nothing answers', async () => {
    const unknown = own(randomToken(12));
    const { killed } = script([], { answers: (socket) => (socket === OTHER ? 1 : 0) });
    expect(await terminate(unknown)).toEqual({ status: 200, json: { terminated: true } });
    expect(await terminate(OTHER)).toEqual({ status: 200, json: { terminated: false } });
    expect(killed).toEqual([unknown]);
    await writer.flush();
    expect(audits('remote_session.terminated')).toEqual([
      {
        actor_user_id: userA,
        target_type: 'server',
        target_id: serverA,
        detail_json: { socket: unknown, origin: 'unknown' },
      },
    ]);
  });

  it('ends my own ended session’s leftover (recorded on it); re-checks right before the kill', async () => {
    const { db } = fixture;
    const ended = insertSession(db, {
      userId: userA,
      serverId: serverA,
      state: 'ended',
      endedAt: 1,
    });
    const { killed } = script([]);
    expect(await terminate(own(ended.token))).toEqual({ status: 200, json: { terminated: true } });
    expect(killed).toEqual([own(ended.token)]);
    await writer.flush();
    expect(events(ended.id)).toEqual([{ type: 'remote_cleanup', detail: { source: 'manual' } }]);
    expect(audits('remote_session.terminated').map((a) => a.detail_json.origin)).toEqual(['ended']);

    // While the connection opened, a session of userB was adopted onto that socket: refused.
    const contested = 'td-yyyy0000-abcdefghijkl';
    script([], {
      answers: () => {
        insertSession(db, { userId: userB, serverId: null, tmuxSocket: contested });
        return 0;
      },
    });
    expect(await terminate(contested)).toMatchObject({ status: 409 });
  });

  it('a host it cannot reach or sign in to is a 502 with the code', async () => {
    const { db } = fixture;
    const bare = insertServer(db, userA, { port: host.port });
    expect(await terminate(OTHER, userA, bare)).toMatchObject({
      status: 502,
      json: { code: 'CREDENTIAL_REQUIRED' },
    });
  });
});

describe('POST /servers/:id/remote-sessions/adopt', () => {
  const adopt = (body: Record<string, unknown>, serverId = serverA) =>
    call('POST', `/servers/${serverId}/remote-sessions/adopt`, { actingUserId: userA, ...body });

  it('creates a session of the server attached to that tmux server (protected, Restoring)', async () => {
    const created = await adopt({ socket: OTHER });
    expect(created.status).toBe(201);
    const sessionId = created.json?.sessionId as string;
    const row = fixture.db.$client
      .prepare(
        'SELECT label, server_id, tmux_socket, protection_effective, status, desired_state, last_ready_at FROM sessions WHERE id = ?',
      )
      .get(sessionId) as Record<string, unknown>;
    expect(row).toMatchObject({
      label: 'web box', // the server's name by default
      server_id: serverA,
      tmux_socket: OTHER,
      protection_effective: 'tmux-control',
      status: 'restoring',
      desired_state: 'running',
    });
    expect(row.last_ready_at).toEqual(expect.any(Number));
    expect(registry.created).toEqual([
      expect.objectContaining({
        id: sessionId,
        tmuxSocket: OTHER,
        protection: 'tmux-control',
        lastReadyAt: expect.any(Number),
        target: expect.objectContaining({ hostname: '127.0.0.1', port: host.port }),
      }),
    ]);
    expect(events(sessionId)).toEqual([
      { type: 'created', detail: { serverId: serverA, adoptedSocket: OTHER } },
    ]);
    expect(audits('remote_session.adopted')).toEqual([
      {
        actor_user_id: userA,
        target_type: 'server',
        target_id: serverA,
        detail_json: { socket: OTHER, origin: 'other', sessionId },
      },
    ]);
    // Nothing on the host is touched by the route itself: the runtime attaches.
    expect(host.connections).toBe(0);

    // The same socket again: it now belongs to a session that runs in Termdock.
    expect(await adopt({ socket: OTHER })).toMatchObject({ status: 409 });
    // A label is cleaned like any session label.
    const unknown = own(randomToken(12));
    const labelled = await adopt({ socket: unknown, label: ' ‮old​ shell ' });
    expect(labelled.status).toBe(201);
    expect(registry.created.at(-1)).toMatchObject({ label: 'old shell' });
    expect(audits('remote_session.adopted').at(-1)?.detail_json.origin).toBe('unknown');
  });

  it('refuses running, foreign and my own ended sessions; honours the running cap', async () => {
    const { db } = fixture;
    const mine = insertSession(db, { userId: userA, serverId: serverA });
    const theirsEnded = insertSession(db, {
      userId: userB,
      serverId: null,
      state: 'ended',
      endedAt: 1,
    });
    const mineEnded = insertSession(db, {
      userId: userA,
      serverId: serverA,
      state: 'ended',
      endedAt: 1,
    });
    for (const socket of [own(mine.token), own(theirsEnded.token)]) {
      expect(await adopt({ socket })).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
    }
    const reopenInstead = await adopt({ socket: own(mineEnded.token) });
    expect(reopenInstead).toMatchObject({ status: 409 });
    expect(reopenInstead.json?.message).toMatch(/reopen/);
    expect((await adopt({ socket: 'td-UPPER-abcdefghijkl' })).status).toBe(400);
    expect((await adopt({ socket: OTHER }, insertServer(db, userB))).status).toBe(404);
    expect(
      (await adopt({ socket: OTHER }, insertServer(db, userA, { kind: 'local' }))).status,
    ).toBe(400);

    db.$client
      .prepare(
        "INSERT INTO instance_settings (key, value_json, updated_at) VALUES ('max_running_sessions_per_user', '1', 0)",
      )
      .run();
    expect(await adopt({ socket: OTHER })).toMatchObject({
      status: 429,
      json: { code: 'RATE_LIMITED' },
    });
    expect(registry.created).toEqual([]);
  });
});

describe('POST /sessions/terminate-all', () => {
  it('ends every session of the acting user through the registry', async () => {
    expect(await call('POST', '/sessions/terminate-all', { actingUserId: userA })).toEqual({
      status: 200,
      json: { terminated: 3 },
    });
    expect(registry.terminatedAll).toEqual([userA]);
    expect((await call('POST', '/sessions/terminate-all', { actingUserId: 'ghost' })).status).toBe(
      403,
    );
    expect((await call('POST', '/sessions/terminate-all', {})).status).toBe(400);
    expect(registry.terminatedAll).toEqual([userA]);
  });
});
