import { existsSync, readFileSync } from 'node:fs';
import { ErrorCode } from '@termavox/shared';
import { describe, expect, it } from 'vitest';
import { authGate } from '../lib/auth/gate.ts';
import { makeRuntime, signIn } from './helpers.ts';

describe('first-run setup token', () => {
  it('logs a one-time token while no user exists and creates the first admin exactly once', async () => {
    const t = makeRuntime();
    try {
      const tokenLogs = t.logs.filter((l) => l.startsWith('warn') && l.includes('setup token'));
      expect(tokenLogs).toHaveLength(1);
      const token = /setup token: (\S+)$/.exec(tokenLogs[0]!)![1]!;
      expect(t.logs[0]).toContain('https://termavox.test/setup');
      expect(t.rt.setup.isOpen()).toBe(true);
      expect(await authGate(t.rt, new Headers())).toMatchObject({
        ok: false,
        reason: 'setup-required',
        redirectTo: '/setup',
      });

      const input = {
        username: 'owner',
        email: 'owner@example.test',
        password: 'first admin password',
      };
      await expect(t.rt.setup.complete('not-the-token', input)).rejects.toMatchObject({
        code: ErrorCode.Forbidden,
      });
      await expect(
        t.rt.setup.complete(token, { ...input, password: 'short' }),
      ).rejects.toMatchObject({
        code: ErrorCode.BadRequest,
      });
      const { userId } = await t.rt.setup.complete(token, input);
      expect(t.rt.setup.isOpen()).toBe(false);
      await expect(t.rt.setup.complete(token, input)).rejects.toMatchObject({
        code: ErrorCode.NotFound,
      });

      const { jar } = await signIn(t.rt, 'owner', { password: 'first admin password' });
      const gate = await authGate(t.rt, jar.headers());
      expect(gate.ok && gate.user).toMatchObject({ id: userId, role: 'admin' });

      // Never persisted in plaintext.
      for (const file of [t.dbFile, `${t.dbFile}-wal`]) {
        if (existsSync(file)) expect(readFileSync(file).includes(token)).toBe(false);
      }

      // A restart with a user present prints no token and keeps setup closed.
      const restarted = makeRuntime({ dir: t.dir, migrate: false });
      expect(restarted.logs.some((l) => l.includes('setup token'))).toBe(false);
      expect(restarted.rt.setup.isOpen()).toBe(false);
      restarted.cleanup();
    } finally {
      t.cleanup();
    }
  });
});
