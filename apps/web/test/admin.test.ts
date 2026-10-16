import { ErrorCode } from '@termdock/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdminDeps,
  adminCreateUser,
  adminResetPassword,
  adminResetTotp,
  adminSaveSettings,
  adminSetBanned,
  adminSetRole,
} from '../lib/admin/core.ts';
import { createUser, type Jar, makeRuntime, signIn, type TestRuntime } from './helpers.ts';

let t: TestRuntime;
let adminJar: Jar;
let userJar: Jar;
let admin: string;
let member: string;
const calls: string[] = [];

/** Internal API stand-in: records what the admin operations asked the daemon to do. */
const internalApi: AdminDeps['internalApi'] = {
  revokeAuthSessions: async (target) => {
    calls.push(`revoke ${target.userId}`);
  },
  terminateUserSessions: async (userId, actingUserId) => {
    calls.push(`terminate ${userId} by ${actingUserId}`);
    return { terminated: 2 };
  },
};

const deps = (): AdminDeps => ({ auth: t.rt.auth, db: t.rt.db, internalApi });

interface AuditRow {
  type: string;
  actor_user_id: string | null;
  target_id: string | null;
  detail_json: string | null;
  ip: string | null;
}
const audit = (type: string) =>
  t.rt.db.$client
    .prepare('SELECT * FROM audit_events WHERE type = ? ORDER BY created_at')
    .all(type) as AuditRow[];

beforeAll(async () => {
  t = makeRuntime();
  admin = (await createUser(t.rt, 'root', { role: 'admin' })).id;
  member = (await createUser(t.rt, 'carol')).id;
  ({ jar: adminJar } = await signIn(t.rt, 'root'));
  ({ jar: userJar } = await signIn(t.rt, 'carol'));
});
afterAll(() => t.cleanup());

describe('admin operations', () => {
  it('answer NOT_FOUND to a signed-in non-admin and change nothing', async () => {
    const h = userJar.headers();
    const notFound = expect.objectContaining({ code: ErrorCode.NotFound });
    await expect(
      adminSetBanned(deps(), h, { userId: admin, banned: true, terminateSessions: true }),
    ).rejects.toEqual(notFound);
    await expect(adminResetTotp(deps(), h, admin)).rejects.toEqual(notFound);
    await expect(
      adminResetPassword(deps(), h, { userId: admin, temporaryPassword: 'x'.repeat(16) }),
    ).rejects.toEqual(notFound);
    await expect(adminSetRole(deps(), h, { userId: member, role: 'admin' })).rejects.toEqual(
      notFound,
    );
    await expect(
      adminSaveSettings(deps(), h, {
        requireTotp: true,
        maxRunningSessionsPerUser: 1,
        localShellVisible: true,
      }),
    ).rejects.toEqual(notFound);
    await expect(
      adminCreateUser(deps(), h, {
        username: 'mallory',
        email: 'mallory@example.test',
        temporaryPassword: 'x'.repeat(16),
      }),
    ).rejects.toEqual(notFound);
    expect(calls).toEqual([]);
    expect(audit('admin_setting.change')).toEqual([]);
    const row = t.rt.db.$client.prepare('SELECT banned, role FROM user WHERE id = ?').get(member);
    expect(row).toEqual({ banned: 0, role: 'user' });
  });

  it('audits sign-in success, failure and lockout without password content', async () => {
    const dave = (await createUser(t.rt, 'dave')).id;
    const before = audit('auth.login_failure').length;
    const wrong = 'wrong password, do not store';
    expect((await signIn(t.rt, 'dave', { password: wrong, ip: '198.51.100.9' })).res.status).toBe(
      401,
    );
    expect((await signIn(t.rt, 'nobodyhere', { password: wrong })).res.status).toBe(401);
    expect((await signIn(t.rt, 'dave', { ip: '198.51.100.9' })).res.status).toBe(200);

    const failures = audit('auth.login_failure').slice(before);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ actor_user_id: null, target_id: dave, ip: '198.51.100.9' });
    expect(JSON.parse(failures[0]!.detail_json!)).toEqual({ stage: 'password', reason: 'invalid' });
    expect(failures[1]).toMatchObject({ target_id: null });
    expect(JSON.parse(failures[1]!.detail_json!)).toMatchObject({ unknownUser: true });
    const successes = audit('auth.login_success').filter((r) => r.actor_user_id === dave);
    expect(successes).toHaveLength(1);
    expect(JSON.parse(successes[0]!.detail_json!)).toEqual({ method: 'password' });

    for (let i = 0; i < 5; i++) await signIn(t.rt, 'dave', { password: wrong, ip: '192.0.2.50' });
    expect(audit('auth.lockout').filter((r) => r.target_id === dave)).toHaveLength(1);
    const all = JSON.stringify(t.rt.db.$client.prepare('SELECT * FROM audit_events').all());
    expect(all).not.toContain(wrong);
    expect(all).not.toContain('nobodyhere');
  });

  it('disables a user: ban, WebSocket revocation and session termination, all audited', async () => {
    const outcome = await adminSetBanned(deps(), adminJar.headers(), {
      userId: member,
      banned: true,
      terminateSessions: true,
    });
    expect(outcome).toEqual({ connectionsClosed: true, terminated: 2, terminateFailed: false });
    expect(calls).toEqual([`revoke ${member}`, `terminate ${member} by ${admin}`]);
    expect(audit('user.ban')).toMatchObject([{ actor_user_id: admin, target_id: member }]);
    expect(audit('auth_session.revoke')).toMatchObject([
      { actor_user_id: admin, target_id: member },
    ]);
    expect(audit('user.sessions_terminate')).toMatchObject([
      { actor_user_id: admin, target_id: member },
    ]);
    // The disabled user's auth sessions are gone; admins cannot disable themselves.
    expect((await signIn(t.rt, 'carol')).res.status).toBe(403);
    await expect(
      adminSetBanned(deps(), adminJar.headers(), { userId: admin, banned: true }),
    ).rejects.toEqual(expect.objectContaining({ code: ErrorCode.BadRequest }));
  });
});
