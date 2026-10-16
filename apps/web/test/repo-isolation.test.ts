import { ErrorCode, uuidv7 } from '@termdock/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_PREFERENCES } from '../lib/preferences/terminal.ts';
import { insertAuditEvent, listAuditEvents, listAuditTypes } from '../lib/repo/audit.ts';
import {
  createHost,
  deleteHost,
  getHost,
  listHostKeys,
  listHosts,
  updateHost,
} from '../lib/repo/hosts.ts';
import { getTerminalPreferences, saveTerminalPreferences } from '../lib/repo/preferences.ts';
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  type ProfileInput,
  updateProfile,
} from '../lib/repo/profiles.ts';
import { createUser, makeRuntime, type TestRuntime } from './helpers.ts';

let t: TestRuntime;
let alice: string;
let bob: string;

const HOST = { name: 'alpha', kind: 'ssh' as const, hostname: '10.0.0.1', port: 22 };
const PROFILE: ProfileInput = {
  name: 'deploy',
  username: 'deploy',
  credentialId: null,
  protectionMode: 'auto',
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

function insertLiveSession(userId: string, hostId: string, profileId: string | null): void {
  t.rt.db.$client
    .prepare(
      `INSERT INTO sessions (id, user_id, profile_id, target_kind, target_host_id, target_hostname,
         target_port, target_username, term, scrollback_lines, label, desired_state, state, status,
         tmux_token, cols, rows, created_at)
       VALUES (?, ?, ?, 'ssh', ?, '10.0.0.1', 22, 'deploy', 'xterm-256color', 5000, 'live',
               'running', 'ready', 'connected', 'tok', 80, 24, ?)`,
    )
    .run(uuidv7(), userId, profileId, hostId, Date.now());
}

describe('repository isolation (user B never reads or changes user A’s rows)', () => {
  it('hosts and their keys', () => {
    const { db } = t.rt;
    const hostId = createHost(db, alice, HOST);
    db.$client
      .prepare(
        `INSERT INTO known_host_keys (id, host_id, key_type, fingerprint_sha256, status, first_seen_at)
         VALUES (?, ?, 'ssh-ed25519', ?, 'trusted', ?)`,
      )
      .run(uuidv7(), hostId, `SHA256:${'A'.repeat(43)}`, Date.now());

    expect(listHosts(db, bob)).toEqual([]);
    expect(getHost(db, bob, hostId)).toBeNull();
    expect(listHostKeys(db, bob, hostId)).toEqual([]);
    expect(updateHost(db, bob, hostId, { ...HOST, name: 'stolen' })).toBe(false);
    expect(deleteHost(db, bob, hostId)).toBe('not_found');

    expect(getHost(db, alice, hostId)).toMatchObject({ name: 'alpha', profileCount: 0 });
    expect(listHostKeys(db, alice, hostId)).toHaveLength(1);
    // A non-ended session blocks the owner's delete (409), not just foreign ones.
    insertLiveSession(alice, hostId, null);
    expect(deleteHost(db, alice, hostId)).toBe('conflict');
  });

  it('connection profiles, including the credential and host they point at', () => {
    const { db } = t.rt;
    const hostA = createHost(db, alice, { ...HOST, name: 'profiles' });
    const created = createProfile(db, alice, hostA, PROFILE);
    expect(created.outcome).toBe('ok');
    const profileId = created.id!;

    expect(getProfile(db, bob, profileId)).toBeNull();
    expect(listProfiles(db, bob, hostA)).toEqual([]);
    expect(updateProfile(db, bob, profileId, { ...PROFILE, username: 'root' })).toBe('not_found');
    expect(deleteProfile(db, bob, profileId)).toBe('not_found');
    expect(createProfile(db, bob, hostA, PROFILE).outcome).toBe('not_found');
    // Alice cannot attach Bob's credential to her profile.
    const bobsKey = insertCredential(bob);
    expect(updateProfile(db, alice, profileId, { ...PROFILE, credentialId: bobsKey })).toBe(
      'credential_not_found',
    );

    expect(getProfile(db, alice, profileId)).toMatchObject({
      username: 'deploy',
      env: { APP_ENV: 'prod' },
      credentialId: null,
    });
    insertLiveSession(alice, hostA, profileId);
    expect(deleteProfile(db, alice, profileId)).toBe('conflict');
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
