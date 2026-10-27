import { ErrorCode, uuidv7 } from '@termavox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_PREFERENCES } from '../lib/preferences/terminal.ts';
import { insertAuditEvent, listAuditEvents, listAuditTypes } from '../lib/repo/audit.ts';
import { listCredentials } from '../lib/repo/credentials.ts';
import {
  getTerminalPreferences,
  getTheme,
  saveTerminalPreferences,
  saveTheme,
} from '../lib/repo/preferences.ts';
import {
  countServers,
  countServersAtAddress,
  createServer,
  deleteServer,
  getServer,
  listServerHostKeys,
  listServers,
  type ServerInput,
  updateServer,
} from '../lib/repo/servers.ts';
import { createUser, makeRuntime, type TestRuntime } from './helpers.ts';

let t: TestRuntime;
let alice: string;
let bob: string;

const SERVER: ServerInput = {
  name: 'alpha',
  kind: 'ssh',
  hostname: '10.0.0.1',
  port: 22,
  username: 'deploy',
  credentialId: null,
  protectionMode: 'auto',
  tmuxTerm: 'auto',
  startupCommand: null,
  env: { APP_ENV: 'prod' },
  keepaliveIntervalS: 15,
  autoReopen: true,
  scrollbackLines: 5000,
};

beforeAll(async () => {
  t = makeRuntime();
  alice = (await createUser(t.rt, 'alice')).id;
  bob = (await createUser(t.rt, 'bob')).id;
});
afterAll(() => t.cleanup());

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

function create(userId: string, input: Partial<ServerInput> = {}): string {
  const created = createServer(t.rt.db, userId, { ...SERVER, ...input });
  if (created.outcome !== 'ok') throw new Error(`create failed: ${created.outcome}`);
  return created.id;
}

function insertLiveSession(userId: string, serverId: string | null): void {
  t.rt.db.$client
    .prepare(
      `INSERT INTO sessions (id, user_id, server_id, target_kind, target_hostname, target_port,
         target_username, term, scrollback_lines, label, desired_state, state, status,
         tmux_token, cols, rows, created_at)
       VALUES (?, ?, ?, 'ssh', '10.0.0.1', 22, 'deploy', 'xterm-256color', 5000, 'live',
               'running', 'ready', 'connected', 'tok', 80, 24, ?)`,
    )
    .run(uuidv7(), userId, serverId, Date.now());
}

function insertHostKey(userId: string, hostname: string, port: number, status = 'trusted'): void {
  t.rt.db.$client
    .prepare(
      `INSERT INTO known_host_keys
         (id, user_id, hostname, port, key_type, fingerprint_sha256, status, first_seen_at)
       VALUES (?, ?, ?, ?, 'ssh-ed25519', ?, ?, ?)`,
    )
    .run(uuidv7(), userId, hostname, port, `SHA256:${'A'.repeat(43)}`, status, Date.now());
}

describe('repository isolation (user B never reads or changes user A’s rows)', () => {
  it('servers, including the credential they point at', () => {
    const { db } = t.rt;
    const serverId = create(alice);
    expect(listServers(db, bob)).toEqual([]);
    expect(countServers(db, bob)).toBe(0);
    expect(getServer(db, bob, serverId)).toBeNull();
    expect(updateServer(db, bob, serverId, { ...SERVER, name: 'stolen' })).toBe('not_found');
    expect(deleteServer(db, bob, serverId)).toBe('not_found');
    // Alice cannot point her server at Bob's credential, on create or on update.
    const bobsKey = insertCredential(bob);
    expect(createServer(db, alice, { ...SERVER, credentialId: bobsKey }).outcome).toBe(
      'credential_not_found',
    );
    expect(updateServer(db, alice, serverId, { ...SERVER, credentialId: bobsKey })).toBe(
      'credential_not_found',
    );
    expect(listCredentials(db, bob)[0]?.serverCount).toBe(0);

    expect(getServer(db, alice, serverId)).toMatchObject({
      name: 'alpha',
      username: 'deploy',
      env: { APP_ENV: 'prod' },
      credentialId: null,
      liveSessionCount: 0,
    });
    const aliceKey = insertCredential(alice);
    expect(updateServer(db, alice, serverId, { ...SERVER, credentialId: aliceKey })).toBe('ok');
    expect(listCredentials(db, alice).find((c) => c.id === aliceKey)?.serverCount).toBe(1);
  });

  it('the terminal type is stored on create and on update, for its owner only (D-49)', () => {
    const { db } = t.rt;
    const serverId = create(alice, { name: 'term', tmuxTerm: 'xterm-256color' });
    expect(getServer(db, alice, serverId)?.tmuxTerm).toBe('xterm-256color');
    expect(updateServer(db, bob, serverId, { ...SERVER, tmuxTerm: 'auto' })).toBe('not_found');
    expect(getServer(db, alice, serverId)?.tmuxTerm).toBe('xterm-256color');
    expect(updateServer(db, alice, serverId, { ...SERVER, name: 'term', tmuxTerm: 'auto' })).toBe(
      'ok',
    );
    expect(getServer(db, alice, serverId)?.tmuxTerm).toBe('auto');
    // A value the code does not know reads as the default.
    db.$client.prepare("UPDATE servers SET tmux_term = 'vt100' WHERE id = ?").run(serverId);
    expect(listServers(db, alice).find((s) => s.id === serverId)?.tmuxTerm).toBe('auto');
  });

  it('a delete is refused while a session from the server runs, and is audited', () => {
    const { db } = t.rt;
    const serverId = create(alice, { name: 'busy' });
    insertLiveSession(alice, serverId);
    expect(getServer(db, alice, serverId)?.liveSessionCount).toBe(1);
    expect(deleteServer(db, alice, serverId)).toBe('conflict');
    db.$client.prepare("UPDATE sessions SET state = 'ended' WHERE server_id = ?").run(serverId);
    expect(deleteServer(db, alice, serverId)).toBe('deleted');
    const types = (
      db.$client
        .prepare('SELECT type FROM audit_events WHERE target_id = ? ORDER BY id')
        .all(serverId) as Array<{ type: string }>
    ).map((r) => r.type);
    expect(types).toEqual(['server.create', 'server.delete']);
  });

  it('duplicates are separate servers; an address is stored normalized', () => {
    const { db } = t.rt;
    const one = create(alice, { name: 'db as app', hostname: 'DB.Internal', username: 'app' });
    const two = create(alice, { name: 'db as root', hostname: 'db.internal', username: 'root' });
    expect(one).not.toBe(two);
    expect(getServer(db, alice, one)?.hostname).toBe('db.internal');
    expect(countServersAtAddress(db, alice, 'DB.INTERNAL', 22)).toBe(2);
    expect(countServersAtAddress(db, bob, 'db.internal', 22)).toBe(0);
    const v6 = create(alice, { name: 'v6', hostname: '[::1]', port: 2222 });
    expect(getServer(db, alice, v6)).toMatchObject({ hostname: '::1', port: 2222 });
  });

  it('host keys belong to the user and the address, never to another user', () => {
    const { db } = t.rt;
    const one = create(alice, { name: 'k1', hostname: 'keys.internal', username: 'app' });
    const two = create(alice, { name: 'k2', hostname: 'keys.internal', username: 'root' });
    const otherPort = create(alice, { name: 'k3', hostname: 'keys.internal', port: 2222 });
    const bobs = create(bob, { name: 'bob-k', hostname: 'keys.internal' });
    insertHostKey(alice, 'keys.internal', 22);
    insertHostKey(bob, 'keys.internal', 22, 'revoked');

    // One decision covers every server of Alice at that hostname and port, and no other.
    expect(listServerHostKeys(db, alice, one)).toHaveLength(1);
    expect(listServerHostKeys(db, alice, two)).toEqual(listServerHostKeys(db, alice, one));
    expect(listServerHostKeys(db, alice, otherPort)).toEqual([]);
    // Bob sees only his own decision for the same address, and nothing through Alice's ids.
    expect(listServerHostKeys(db, bob, bobs).map((k) => k.status)).toEqual(['revoked']);
    expect(listServerHostKeys(db, bob, one)).toEqual([]);
    // Decisions outlive the servers: deleting both leaves the key for the address.
    expect(deleteServer(db, alice, one)).toBe('deleted');
    expect(deleteServer(db, alice, two)).toBe('deleted');
    const again = create(alice, { name: 'k1 again', hostname: 'KEYS.internal' });
    expect(listServerHostKeys(db, alice, again)).toHaveLength(1);
  });

  it('terminal preferences', () => {
    const { db } = t.rt;
    saveTerminalPreferences(db, alice, { ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 18 });
    expect(getTerminalPreferences(db, bob)).toEqual(DEFAULT_TERMINAL_PREFERENCES);
    saveTerminalPreferences(db, bob, { ...DEFAULT_TERMINAL_PREFERENCES, colorScheme: 'buff' });
    expect(getTerminalPreferences(db, alice)).toMatchObject({ fontSize: 18, colorScheme: 'board' });
    // Stored JSON is validated: an invalid field falls back to its default.
    db.$client
      .prepare('UPDATE user_preferences SET terminal_json = ? WHERE user_id = ?')
      .run('{"fontSize": 99, "allowOsc52Write": "yes"}', alice);
    expect(getTerminalPreferences(db, alice)).toEqual(DEFAULT_TERMINAL_PREFERENCES);
  });

  it('theme (plan D-55), beside the terminal preferences', () => {
    const { db } = t.rt;
    saveTheme(db, alice, 'light');
    expect(getTheme(db, alice)).toBe('light');
    expect(getTheme(db, bob)).toBe('system');
    // A first save creates the row with the default terminal preferences; the theme never
    // touches them.
    const carol = uuidv7();
    expect(getTheme(db, carol)).toBeNull();
    saveTheme(db, bob, 'dark');
    expect(getTerminalPreferences(db, bob)).toMatchObject({ colorScheme: 'buff' });
    expect(getTheme(db, alice)).toBe('light');
    db.$client
      .prepare('UPDATE user_preferences SET theme = ? WHERE user_id = ?')
      .run('sepia', alice);
    expect(getTheme(db, alice)).toBeNull();
    expect(() => saveTheme(db, alice, 'sepia' as never)).toThrow();
  });

  it('audit events (admins only)', () => {
    const { db } = t.rt;
    insertAuditEvent(db, {
      type: 'auth.password_change',
      actorUserId: alice,
      targetType: 'user',
      targetId: alice,
    });
    const asBob = { id: bob, role: 'user' };
    expect(() => listAuditEvents(db, asBob, {}, { limit: 10, offset: 0 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.Forbidden }),
    );
    expect(() => listAuditTypes(db, asBob)).toThrowError(
      expect.objectContaining({ code: ErrorCode.Forbidden }),
    );
    const asAdmin = { id: bob, role: 'user,admin' };
    const { rows } = listAuditEvents(db, asAdmin, { actorId: alice }, { limit: 10, offset: 0 });
    expect(rows.map((r) => [r.type, r.actorName])).toContainEqual([
      'auth.password_change',
      'alice',
    ]);
  });
});
