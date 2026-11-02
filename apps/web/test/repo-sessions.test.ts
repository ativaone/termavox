import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createNote } from '../lib/repo/notes.ts';
import { countServers } from '../lib/repo/servers.ts';
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

function addServer(sqlite: Sqlite, userId: string, name: string): string {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO servers (id, user_id, name, kind, hostname, port, username, created_at, updated_at)
       VALUES (?, ?, ?, 'ssh', ?, 22, 'deploy', 0, 0)`,
    )
    .run(id, userId, name, `${name}.internal`);
  return id;
}

function addSession(
  sqlite: Sqlite,
  userId: string,
  serverId: string | null,
  label: string,
  status: string,
  times: { created: number; ended?: number } = { created: 1 },
  target: { kind?: 'ssh' | 'local'; hostname?: string; port?: number; username?: string } = {},
): string {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO sessions (id, user_id, server_id, target_kind, target_hostname, target_port,
         target_username, term, scrollback_lines, label, desired_state, state, status,
         protection_effective, tmux_token, cols, rows, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'xterm-256color', 5000, ?,
         'running', 'ready', ?, 'tmux-control', ?, 80, 24, ?, ?)`,
    )
    .run(
      id,
      userId,
      serverId,
      target.kind ?? 'ssh',
      target.hostname ?? 'snapshot.internal',
      target.port ?? 22,
      target.username ?? 'deploy',
      label,
      status,
      randomUUID(),
      times.created,
      times.ended ?? null,
    );
  return id;
}

describe('bay repository (user-scoped)', () => {
  it("never returns another user's sessions; shows each session's snapshotted target", () => {
    const t = makeRuntime();
    try {
      const sqlite = t.rt.db.$client;
      const alice = addUser(sqlite, 'alice');
      const bob = addUser(sqlite, 'bob');
      const aliceServer = addServer(sqlite, alice, 'api-prod');
      const bobServer = addServer(sqlite, bob, 'bob-secret-server');
      addSession(sqlite, alice, aliceServer, 'api', 'connected', undefined, {
        hostname: 'api.internal',
        port: 2222,
      });
      // A row pointing at another user's server must not leak anything of that server.
      addSession(sqlite, alice, bobServer, 'odd', 'reconnecting');
      addSession(sqlite, alice, null, 'here', 'connected', undefined, {
        kind: 'local',
        hostname: 'localhost',
        port: 0,
        username: '',
      });
      addSession(sqlite, bob, bobServer, 'bob-shell', 'connected');

      const bay = listBaySessions(t.rt.db, alice);
      expect(bay.sessions.map((s) => s.label).sort()).toEqual(['api', 'here', 'odd']);
      expect(bay.sessions.find((s) => s.label === 'api')).toMatchObject({
        kind: 'ssh',
        username: 'deploy',
        hostname: 'api.internal',
        port: 2222,
      });
      expect(bay.sessions.find((s) => s.label === 'odd')?.hostname).toBe('snapshot.internal');
      expect(bay.sessions.find((s) => s.label === 'here')).toMatchObject({
        kind: 'local',
        serverDeleted: true, // inserted without a server: as after the server's deletion
      });
      expect(bay.sessions.find((s) => s.label === 'api')?.serverDeleted).toBe(false);
      // Desktop notifications: off unless the owner turned them on.
      expect(bay.sessions.find((s) => s.label === 'api')?.notify).toBe(false);
      sqlite.prepare("UPDATE sessions SET notify = 1 WHERE label = 'odd'").run();
      expect(listBaySessions(t.rt.db, alice).sessions.find((s) => s.label === 'odd')?.notify).toBe(
        true,
      );
      expect(JSON.stringify(bay)).not.toContain('bob');
      expect(countServers(t.rt.db, alice)).toBe(1);
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

  it('also lists older ended sessions that have notes, in order and without duplicates', () => {
    const t = makeRuntime();
    try {
      const sqlite = t.rt.db.$client;
      const user = addUser(sqlite, 'dana');
      const other = addUser(sqlite, 'erin');
      const ids: string[] = [];
      for (let i = 0; i < ENDED_SHOWN + 5; i += 1) {
        ids.push(
          addSession(sqlite, user, null, `e-${i}`, 'ended', { created: i, ended: 1000 + i }),
        );
      }
      const live = addSession(sqlite, user, null, 'live', 'connected');
      const note = (sessionId: string) => {
        expect(createNote(t.rt.db, user, sessionId, 'n').outcome).toBe('ok');
      };
      note(ids[0]!); // the oldest: past the window
      note(ids[0]!);
      note(ids[2]!); // past the window
      note(ids[ENDED_SHOWN + 4]!); // the newest: already in the window
      note(live);
      addSession(sqlite, other, null, 'theirs', 'ended', { created: 1, ended: 1 });

      const bay = listBaySessions(t.rt.db, user);
      const ended = bay.sessions.filter((s) => s.status === 'ended').map((s) => s.label);
      const newest = Array.from({ length: ENDED_SHOWN }, (_, i) => `e-${ENDED_SHOWN + 4 - i}`);
      expect(ended).toEqual([...newest, 'e-2', 'e-0']);
      expect(bay.sessions[0]?.label).toBe('live');
      expect(bay.endedTotal).toBe(ENDED_SHOWN + 5);
      expect(bay.noteCounts).toEqual({
        [ids[0]!]: 2,
        [ids[2]!]: 1,
        [ids[ENDED_SHOWN + 4]!]: 1,
        [live]: 1,
      });
      const count = (label: string) => bay.sessions.find((s) => s.label === label)?.noteCount;
      expect(count('e-0')).toBe(2);
      expect(count(`e-${ENDED_SHOWN + 4}`)).toBe(1);
      expect(count(`e-${ENDED_SHOWN + 3}`)).toBe(0);
      expect(count('live')).toBe(1);

      // Another user's bay sees neither these sessions nor their counts.
      expect(listBaySessions(t.rt.db, other).noteCounts).toEqual({});
      expect(listBaySessions(t.rt.db, other).sessions.map((s) => s.label)).toEqual(['theirs']);
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
    notify: false,
    status,
    protection: null,
    kind: 'ssh' as const,
    username: 'u',
    hostname: 'h',
    port: 22,
    serverDeleted: false,
    createdAt: 0,
    endedAt: null,
    noteCount: 0,
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
