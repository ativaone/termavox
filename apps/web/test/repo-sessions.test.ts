import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { countHosts } from '../lib/repo/hosts.ts';
import { listBaySessions } from '../lib/repo/sessions.ts';
import { setUserLocale } from '../lib/repo/users.ts';
import { ENDED_SHOWN, groupIntoLanes, laneChanged } from '../lib/sessions/lanes.ts';
import { makeRuntime } from './helpers.ts';

type Sqlite = ReturnType<typeof makeRuntime>['rt']['db']['$client'];

function addUser(sqlite: Sqlite, username: string): string {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, username, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(id, username, `${username}@example.test`, username, 0, 0);
  return id;
}

function addHost(sqlite: Sqlite, userId: string, name: string): string {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO hosts (id, user_id, name, kind, hostname, port, created_at, updated_at)
       VALUES (?, ?, ?, 'ssh', ?, 22, 0, 0)`,
    )
    .run(id, userId, name, `${name}.internal`);
  return id;
}

function addSession(
  sqlite: Sqlite,
  userId: string,
  hostId: string | null,
  label: string,
  status: string,
  times: { created: number; ended?: number } = { created: 1 },
): string {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO sessions (id, user_id, target_kind, target_host_id, target_hostname, target_port,
         target_username, term, scrollback_lines, label, desired_state, state, status,
         protection_effective, tmux_token, cols, rows, created_at, ended_at)
       VALUES (?, ?, 'ssh', ?, 'fallback.internal', 22, 'deploy', 'xterm-256color', 5000, ?,
         'running', 'ready', ?, 'tmux-control', ?, 80, 24, ?, ?)`,
    )
    .run(id, userId, hostId, label, status, randomUUID(), times.created, times.ended ?? null);
  return id;
}

describe('bay repository (user-scoped)', () => {
  it("never returns another user's sessions or host names", () => {
    const t = makeRuntime();
    try {
      const sqlite = t.rt.db.$client;
      const alice = addUser(sqlite, 'alice');
      const bob = addUser(sqlite, 'bob');
      const aliceHost = addHost(sqlite, alice, 'api-prod');
      const bobHost = addHost(sqlite, bob, 'bob-secret-host');
      addSession(sqlite, alice, aliceHost, 'api', 'connected');
      // A row pointing at another user's host must not leak that host's name.
      addSession(sqlite, alice, bobHost, 'odd', 'reconnecting');
      addSession(sqlite, bob, bobHost, 'bob-shell', 'connected');

      const bay = listBaySessions(t.rt.db, alice);
      expect(bay.sessions.map((s) => s.label).sort()).toEqual(['api', 'odd']);
      expect(bay.sessions.find((s) => s.label === 'api')?.host).toBe('api-prod');
      expect(bay.sessions.find((s) => s.label === 'odd')?.host).toBe('fallback.internal');
      expect(JSON.stringify(bay)).not.toContain('bob');
      expect(countHosts(t.rt.db, alice)).toBe(1);
      expect(listBaySessions(t.rt.db, randomUUID()).sessions).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('lists the latest ended sessions only, with the total, and validates statuses', () => {
    const t = makeRuntime();
    try {
      const sqlite = t.rt.db.$client;
      const user = addUser(sqlite, 'carol');
      for (let i = 0; i < ENDED_SHOWN + 5; i += 1) {
        addSession(sqlite, user, null, `old-${i}`, 'ended', { created: i, ended: 1000 + i });
      }
      addSession(sqlite, user, null, 'weird', 'not-a-status');
      const bay = listBaySessions(t.rt.db, user);
      const ended = bay.sessions.filter((s) => s.status === 'ended');
      expect(ended).toHaveLength(ENDED_SHOWN);
      expect(ended[0]?.label).toBe(`old-${ENDED_SHOWN + 4}`);
      expect(bay.endedTotal).toBe(ENDED_SHOWN + 5);
      expect(bay.sessions.find((s) => s.label === 'weird')?.status).toBe('disconnected');
    } finally {
      t.cleanup();
    }
  });

  it('writes the locale only for the given user', () => {
    const t = makeRuntime();
    try {
      const sqlite = t.rt.db.$client;
      const alice = addUser(sqlite, 'alice');
      const bob = addUser(sqlite, 'bob');
      setUserLocale(t.rt.db, alice, 'pt-BR');
      const locales = sqlite.prepare('SELECT username, locale FROM user ORDER BY username').all();
      expect(locales).toEqual([
        { username: 'alice', locale: 'pt-BR' },
        { username: 'bob', locale: 'en' },
      ]);
      expect(bob).toBeTruthy();
    } finally {
      t.cleanup();
    }
  });
});

describe('lanes', () => {
  const s = (id: string, status: 'connected' | 'action_required' | 'ended' | 'reconnecting') => ({
    id,
    label: id,
    status,
    protection: null,
    user: 'u',
    host: 'h',
    createdAt: 0,
    endedAt: null,
  });

  it('orders non-empty lanes by urgency and keeps order inside a lane', () => {
    const lanes = groupIntoLanes([
      s('a', 'connected'),
      s('b', 'ended'),
      s('c', 'action_required'),
      s('d', 'connected'),
    ]);
    expect(lanes.map((l) => l.status)).toEqual(['action_required', 'connected', 'ended']);
    expect(lanes[1]?.sessions.map((x) => x.id)).toEqual(['a', 'd']);
  });

  it('detects a strip that changed lane', () => {
    expect(laneChanged([s('a', 'connected')], [s('a', 'reconnecting')])).toBe(true);
    expect(laneChanged([s('a', 'connected')], [s('a', 'connected'), s('b', 'ended')])).toBe(false);
  });
});
