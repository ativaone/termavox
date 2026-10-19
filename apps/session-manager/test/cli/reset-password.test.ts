import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RevokeAuthSessionsRequest } from '@termdock/protocol';
import { hashPassword, uuidv7, verifyPassword } from '@termdock/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeConnectionsViaInternalApi,
  EXIT,
  type ResetPasswordDeps,
  runResetPassword,
} from '../../src/cli/reset-password.ts';
import type { Sqlite } from '../../src/store/sqlite.ts';
import { insertUser, type TempDb, tempDb } from '../store/fixture.ts';

const OLD_PASSWORD = 'the-forgotten-password';
const TEMPORARY = 'abcdefghijklmnopqrst';

/** A Better Auth user as web stores it: username, a credential account, signed-in sessions. */
async function addUser(
  sqlite: Sqlite,
  db: TempDb['db'],
  username: string,
  opts: { role?: string; banned?: boolean; sessions?: number } = {},
): Promise<string> {
  const id = insertUser(db, { role: opts.role ?? 'user', banned: opts.banned ?? false });
  const now = Date.now();
  sqlite.prepare('UPDATE user SET username = ? WHERE id = ?').run(username, id);
  sqlite
    .prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
    )
    .run(uuidv7(), id, id, await hashPassword(OLD_PASSWORD), now, now);
  for (let i = 0; i < (opts.sessions ?? 0); i++) {
    sqlite
      .prepare(
        `INSERT INTO auth_session (id, token, user_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(uuidv7(), uuidv7(), id, now + 86_400_000, now, now);
  }
  return id;
}

function passwordOf(sqlite: Sqlite, userId: string): string {
  return (
    sqlite
      .prepare("SELECT password FROM account WHERE user_id = ? AND provider_id = 'credential'")
      .get(userId) as { password: string }
  ).password;
}

function count(sqlite: Sqlite, sql: string, ...params: unknown[]): number {
  return (sqlite.prepare(sql).get(...params) as { n: number }).n;
}

describe('reset-password (plan D-36)', () => {
  let fixture: TempDb;
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    fixture?.cleanup();
  });

  function io(env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        env,
        cwd: fixture.dir,
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
      },
    };
  }

  function fakeDeps(closed = true) {
    const closedFor: string[] = [];
    const deps: ResetPasswordDeps = {
      generatePassword: () => TEMPORARY,
      closeConnections: async (userId) => {
        closedFor.push(userId);
        return closed;
      },
    };
    return { deps, closedFor };
  }

  it('sets a temporary password, forces a change, ends the sign-ins and audits it', async () => {
    fixture = tempDb();
    const sqlite = fixture.db.$client;
    const admin = await addUser(sqlite, fixture.db, 'alice', { role: 'admin', sessions: 2 });
    const other = await addUser(sqlite, fixture.db, 'bob', { sessions: 1 });
    const { deps, closedFor } = fakeDeps();
    const run = io();

    // Usernames are stored lowercase; what the operator types is trimmed and lowercased.
    expect(await runResetPassword(['--data-dir', '.', ' Alice '], run.io, deps)).toBe(EXIT.ok);

    expect(run.err).toEqual([]);
    expect(run.out[0]).toBe('reset-password: alice (admin)');
    expect(run.out[1]).toBe(`temporary password: ${TEMPORARY}`);
    expect(run.out.join('\n')).toContain(
      '2 sign-ins ended; open terminals were disconnected (their sessions keep running).',
    );
    expect(run.out.join('\n')).not.toContain('disabled');
    const hash = passwordOf(sqlite, admin);
    expect(await verifyPassword(hash, TEMPORARY)).toBe(true);
    expect(await verifyPassword(hash, OLD_PASSWORD)).toBe(false);
    expect(await verifyPassword(passwordOf(sqlite, other), OLD_PASSWORD)).toBe(true);
    const flags = sqlite
      .prepare('SELECT id, must_change_password AS must FROM user ORDER BY username')
      .all();
    expect(flags).toEqual([
      { id: admin, must: 1 },
      { id: other, must: 0 },
    ]);
    expect(count(sqlite, 'SELECT count(*) AS n FROM auth_session WHERE user_id = ?', admin)).toBe(
      0,
    );
    expect(count(sqlite, 'SELECT count(*) AS n FROM auth_session WHERE user_id = ?', other)).toBe(
      1,
    );
    expect(closedFor).toEqual([admin]);
    const audit = sqlite
      .prepare(
        'SELECT actor_user_id, type, target_type, target_id, detail_json, ip FROM audit_events',
      )
      .all();
    expect(audit).toEqual([
      {
        actor_user_id: null,
        type: 'auth.password_reset',
        target_type: 'user',
        target_id: admin,
        detail_json: JSON.stringify({ via: 'operator', signInsEnded: 2 }),
        ip: null,
      },
    ]);
  });

  it('generates a 20-character [a-z2-7] password by default', async () => {
    fixture = tempDb();
    const sqlite = fixture.db.$client;
    const id = await addUser(sqlite, fixture.db, 'alice', { role: 'admin' });
    const run = io();
    const code = await runResetPassword(['alice', '--data-dir', fixture.dir], run.io, {
      closeConnections: async () => true,
    });
    expect(code).toBe(EXIT.ok);
    const password = run.out[1]?.replace('temporary password: ', '') ?? '';
    expect(password).toMatch(/^[a-z2-7]{20}$/);
    expect(await verifyPassword(passwordOf(sqlite, id), password)).toBe(true);
    expect(run.out.join('\n')).toContain('0 sign-ins ended;');
  });

  it('refuses an unknown username, lists the users and changes nothing', async () => {
    fixture = tempDb();
    const sqlite = fixture.db.$client;
    const admin = await addUser(sqlite, fixture.db, 'alice', { role: 'admin', sessions: 1 });
    await addUser(sqlite, fixture.db, 'bob');
    const before = passwordOf(sqlite, admin);
    const { deps, closedFor } = fakeDeps();
    const run = io();

    expect(await runResetPassword(['--data-dir', '.', 'carol'], run.io, deps)).toBe(EXIT.failed);

    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      'reset-password: no user named "carol"; users: alice (admin), bob (user)',
      'nothing was changed',
    ]);
    expect(passwordOf(sqlite, admin)).toBe(before);
    expect(count(sqlite, 'SELECT count(*) AS n FROM auth_session')).toBe(1);
    expect(count(sqlite, 'SELECT count(*) AS n FROM audit_events')).toBe(0);
    expect(closedFor).toEqual([]);
  });

  it('says so when the terminals could not be disconnected or the account is disabled', async () => {
    fixture = tempDb();
    const sqlite = fixture.db.$client;
    await addUser(sqlite, fixture.db, 'alice', { banned: true, sessions: 1 });
    const { deps } = fakeDeps(false);
    const run = io();
    expect(await runResetPassword(['--data-dir', '.', 'alice'], run.io, deps)).toBe(EXIT.ok);
    const printed = run.out.join('\n');
    expect(printed).toContain(
      '1 sign-in ended; open terminals could not be disconnected (session-manager did not answer)',
    );
    expect(printed).toContain('This account is disabled: an admin must enable it');
  });

  it('never creates a database at a wrong path', async () => {
    fixture = tempDb();
    const empty = mkdtempSync(join(tmpdir(), 'termdock-reset-'));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const run = io();
    const code = await runResetPassword(['--data-dir', empty, 'alice'], run.io, fakeDeps().deps);
    expect(code).toBe(EXIT.failed);
    expect(run.err).toEqual([`reset-password: no database at ${join(empty, 'app.db')}`]);
    expect(readdirSync(empty)).toEqual([]);
  });

  it('rejects a bad command line', async () => {
    fixture = tempDb();
    for (const argv of [[], ['alice', 'bob'], ['--nope', 'alice'], ['  ']]) {
      const run = io();
      expect(await runResetPassword(argv, run.io, fakeDeps().deps)).toBe(EXIT.usage);
      expect(run.err.at(-1)).toMatch(/^Usage: node src\/cli\/reset-password\.ts <username>/);
    }
    const help = io();
    expect(await runResetPassword(['--help'], help.io)).toBe(EXIT.ok);
    expect(help.out[0]).toMatch(/^Usage:/);
  });
});

describe('closing the WebSockets through the internal API', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function fakeDaemon(status: number) {
    const requests: Array<{ method?: string; url?: string; auth?: string; body: unknown }> = [];
    const server = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          body: JSON.parse(raw),
        });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    const dir = mkdtempSync(join(tmpdir(), 'termdock-reset-token-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const token = 'f'.repeat(64);
    const tokenFile = join(dir, 'internal_token');
    writeFileSync(tokenFile, `${token}\n`);
    const env = {
      TERMDOCK_INTERNAL_TOKEN_FILE: tokenFile,
      TERMDOCK_INTERNAL_HOST: '127.0.0.1',
      TERMDOCK_INTERNAL_PORT: String((server.address() as AddressInfo).port),
    };
    return { requests, env, token };
  }

  it('posts the user to /auth-sessions/revoke with the bearer token', async () => {
    const daemon = await fakeDaemon(204);
    expect(await closeConnectionsViaInternalApi(daemon.env, 'user-1')).toBe(true);
    expect(daemon.requests).toHaveLength(1);
    const [request] = daemon.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/internal/v1/auth-sessions/revoke');
    expect(request?.auth).toBe(`Bearer ${daemon.token}`);
    expect(RevokeAuthSessionsRequest.parse(request?.body)).toEqual({ userId: 'user-1' });
  });

  it('reports false when the daemon refuses, is unreachable or is not configured', async () => {
    const daemon = await fakeDaemon(401);
    expect(await closeConnectionsViaInternalApi(daemon.env, 'user-1')).toBe(false);
    expect(
      await closeConnectionsViaInternalApi({ ...daemon.env, TERMDOCK_INTERNAL_PORT: '1' }, 'u'),
    ).toBe(false);
    expect(await closeConnectionsViaInternalApi({}, 'user-1')).toBe(false);
  });
});
