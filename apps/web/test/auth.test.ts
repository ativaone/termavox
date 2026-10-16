import { ErrorCode } from '@termdock/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changePassword,
  createUserWithTemporaryPassword,
  resetUserTotp,
  setTemporaryPassword,
} from '../lib/auth/account.ts';
import { authGate } from '../lib/auth/gate.ts';
import {
  call,
  createUser,
  enrollTotp,
  type Jar,
  makeRuntime,
  PASSWORD,
  signIn,
  type TestRuntime,
  totp,
} from './helpers.ts';

let t: TestRuntime;
let adminJar: Jar;

beforeAll(async () => {
  t = makeRuntime();
  await createUser(t.rt, 'root', { role: 'admin' });
  ({ jar: adminJar } = await signIn(t.rt, 'root'));
});
afterAll(() => t.cleanup());

const gate = (jar: Jar) => authGate(t.rt, jar.headers());
const userRow = (id: string) =>
  t.rt.db.$client.prepare('SELECT * FROM user WHERE id = ?').get(id) as Record<string, unknown>;

describe('Better Auth core (S6)', () => {
  it('signs an admin-created user in by username with argon2id and Strict cookies', async () => {
    const alice = await createUser(t.rt, 'alice');
    const { res, jar } = await signIn(t.rt, 'Alice', { ip: '198.51.100.7' });
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Secure-termdock.session_token='));
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=604800/);
    const result = await gate(jar);
    expect(result.ok && result.user.id).toBe(alice.id);
    expect(result.ok && result.session.ipAddress).toBe('198.51.100.7');
    const account = t.rt.db.$client
      .prepare("SELECT password FROM account WHERE user_id = ? AND provider_id = 'credential'")
      .get(alice.id) as { password: string };
    expect(account.password).toMatch(/^\$argon2id\$v=19\$/);
    // Username only: email sign-in and public sign-up are not served.
    const byEmail = await call(t.rt, 'POST', '/sign-in/email', {
      body: { email: 'alice@example.test', password: PASSWORD },
    });
    expect(byEmail.status).toBe(404);
    const signUp = await call(t.rt, 'POST', '/sign-up/email', {
      body: { email: 'x@example.test', password: PASSWORD, name: 'x' },
    });
    expect(signUp.status).toBe(404);
  });

  it('locks a (username, IP) pair after 5 failures while another IP still signs in', async () => {
    await createUser(t.rt, 'bob');
    for (let i = 0; i < 5; i++) {
      const { res } = await signIn(t.rt, 'bob', { password: 'wrong password!', ip: '192.0.2.1' });
      expect(res.status).toBe(401);
    }
    const locked = await signIn(t.rt, 'bob', { ip: '192.0.2.1' });
    expect(locked.res.status).toBe(429);
    expect(locked.res.headers.get('retry-after')).toBe('30');
    expect(await locked.res.json()).toMatchObject({ code: 'SIGN_IN_LOCKED' });
    const otherIp = await signIn(t.rt, 'bob', { ip: '192.0.2.2' });
    expect(otherIp.res.status).toBe(200);
  });

  it('requires the TOTP code at sign-in once enrolled, then trusts the device', async () => {
    await createUser(t.rt, 'carol');
    const { jar } = await signIn(t.rt, 'carol');
    const uri = await enrollTotp(t.rt, jar);

    const second = await signIn(t.rt, 'carol');
    expect(await second.res.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await gate(second.jar)).ok).toBe(false);
    const wrong = await call(t.rt, 'POST', '/two-factor/verify-totp', {
      body: { code: totp(uri) === '000000' ? '111111' : '000000' },
      jar: second.jar,
    });
    expect(wrong.status).toBe(401);
    const verified = await call(t.rt, 'POST', '/two-factor/verify-totp', {
      body: { code: totp(uri), trustDevice: true },
      jar: second.jar,
    });
    expect(verified.status).toBe(200);
    expect((await gate(second.jar)).ok).toBe(true);

    // A trusted device (30 days) skips the second factor.
    const trusted = second.jar.copy((name) => name.endsWith('trust_device'));
    const third = await signIn(t.rt, 'carol', { jar: trusted });
    expect(await third.res.json()).not.toHaveProperty('twoFactorRedirect');
    expect((await gate(trusted)).ok).toBe(true);
  });

  it('holds a temporary password on the forced change until it is done', async () => {
    const { userId } = await createUserWithTemporaryPassword(t.rt, adminJar.headers(), {
      username: 'dave',
      email: 'dave@example.test',
      temporaryPassword: 'temporary password 1',
    });
    const { jar } = await signIn(t.rt, 'dave', { password: 'temporary password 1' });
    expect(await gate(jar)).toMatchObject({
      ok: false,
      reason: 'password-change',
      redirectTo: '/login/change-password',
    });
    expect((await authGate(t.rt, jar.headers(), { allow: ['password-change'] })).ok).toBe(true);
    // Better Auth's own endpoints are fenced too, except the allowlist.
    const blocked = await call(t.rt, 'GET', '/list-sessions', { jar });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'AUTH_REQUIREMENT_PENDING' });
    expect((await call(t.rt, 'GET', '/get-session', { jar })).status).toBe(200);
    const same = await call(t.rt, 'POST', '/change-password', {
      body: { currentPassword: 'temporary password 1', newPassword: 'temporary password 1' },
      jar,
    });
    expect(same.status).toBe(400);

    await changePassword(t.rt, jar.headers(), {
      currentPassword: 'temporary password 1',
      newPassword: 'my own password 42',
    });
    expect(userRow(userId).must_change_password).toBe(0);
    const again = await signIn(t.rt, 'dave', { password: 'my own password 42' });
    expect((await gate(again.jar)).ok).toBe(true);

    // Admin reset to a new temporary password: sessions revoked, forced change again.
    await setTemporaryPassword(t.rt, adminJar.headers(), userId, 'temporary password 2');
    expect(await gate(again.jar)).toMatchObject({ ok: false, reason: 'unauthenticated' });
    const reset = await signIn(t.rt, 'dave', { password: 'temporary password 2' });
    expect(await gate(reset.jar)).toMatchObject({ ok: false, reason: 'password-change' });
  });

  it('forces TOTP enrollment (per user and instance-wide) and an admin reset re-forces it', async () => {
    const erin = await createUser(t.rt, 'erin', { totpRequired: true });
    const { jar } = await signIn(t.rt, 'erin');
    expect(await gate(jar)).toMatchObject({ ok: false, reason: 'totp-enrollment' });
    expect((await call(t.rt, 'GET', '/list-sessions', { jar })).status).toBe(403);
    await enrollTotp(t.rt, jar);
    expect((await gate(jar)).ok).toBe(true);
    const disable = await call(t.rt, 'POST', '/two-factor/disable', {
      body: { password: PASSWORD },
      jar,
    });
    expect(disable.status).toBe(403);

    // Only admins may reset; the reset drops TOTP and the gate asks for a new enrollment.
    await expect(resetUserTotp(t.rt, jar.headers(), erin.id)).rejects.toMatchObject({
      code: ErrorCode.Forbidden,
    });
    await resetUserTotp(t.rt, adminJar.headers(), erin.id);
    expect(await gate(jar)).toMatchObject({ ok: false, reason: 'totp-enrollment' });
    const fresh = await signIn(t.rt, 'erin');
    expect(await fresh.res.json()).not.toHaveProperty('twoFactorRedirect');

    // Instance-wide requirement.
    await createUser(t.rt, 'frank');
    const settings = t.rt.db.$client;
    settings
      .prepare(
        "INSERT INTO instance_settings (key, value_json, updated_at) VALUES ('require_totp', 'true', ?)",
      )
      .run(Date.now());
    try {
      const frank = await signIn(t.rt, 'frank');
      expect(await gate(frank.jar)).toMatchObject({ ok: false, reason: 'totp-enrollment' });
    } finally {
      settings.prepare("DELETE FROM instance_settings WHERE key = 'require_totp'").run();
    }
  });

  it('rejects banned users at sign-in and on existing sessions', async () => {
    const gina = await createUser(t.rt, 'gina');
    const { jar } = await signIn(t.rt, 'gina');
    await t.rt.auth.api.banUser({ headers: adminJar.headers(), body: { userId: gina.id } });
    expect(await gate(jar)).toMatchObject({ ok: false, reason: 'unauthenticated' });
    expect((await signIn(t.rt, 'gina')).res.status).toBe(403);

    // A ban written straight to the DB leaves the session row; the gate still refuses it.
    const hank = await createUser(t.rt, 'hank');
    const hankSession = await signIn(t.rt, 'hank');
    t.rt.db.$client.prepare('UPDATE user SET banned = 1 WHERE id = ?').run(hank.id);
    expect(await gate(hankSession.jar)).toMatchObject({ ok: false, reason: 'banned' });
    const blocked = await call(t.rt, 'GET', '/list-sessions', { jar: hankSession.jar });
    expect(blocked.status).toBe(403);
  });
});
