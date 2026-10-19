import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCKOUT_POLICY, LoginLockout } from '../lib/auth/lockout.ts';

function setup(policy = DEFAULT_LOCKOUT_POLICY) {
  let now = 1_000_000;
  const lockout = new LoginLockout(policy, () => now);
  return { lockout, advance: (ms: number) => (now += ms) };
}

describe('LoginLockout', () => {
  it('locks a (username, IP) pair after 5 failures, doubling up to 15 min', () => {
    const { lockout, advance } = setup();
    for (let i = 0; i < 4; i++)
      expect(lockout.recordFailure('admin', '198.51.100.1').lockedForMs).toBe(0);
    expect(lockout.retryAfterMs('admin', '198.51.100.1')).toBe(0);
    expect(lockout.recordFailure('admin', '198.51.100.1').lockedForMs).toBe(30_000);
    expect(lockout.retryAfterMs('ADMIN ', '198.51.100.1')).toBe(30_000);
    const locks = [];
    for (let i = 0; i < 6; i++) {
      advance(lockout.retryAfterMs('admin', '198.51.100.1'));
      locks.push(lockout.recordFailure('admin', '198.51.100.1').lockedForMs);
    }
    expect(locks).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it('keeps other IPs and other usernames unaffected, and clears on success', () => {
    const { lockout } = setup();
    for (let i = 0; i < 5; i++) lockout.recordFailure('admin', '198.51.100.1');
    expect(lockout.retryAfterMs('admin', '198.51.100.1')).toBeGreaterThan(0);
    expect(lockout.retryAfterMs('admin', '198.51.100.2')).toBe(0);
    expect(lockout.retryAfterMs('alice', '198.51.100.1')).toBe(0);
    lockout.recordSuccess('admin', '198.51.100.1');
    expect(lockout.retryAfterMs('admin', '198.51.100.1')).toBe(0);
  });

  it('forgets a quiet pair and bounds the number of tracked pairs, keeping running locks', () => {
    const { lockout, advance } = setup({ ...DEFAULT_LOCKOUT_POLICY, maxEntries: 2 });
    for (let i = 0; i < 5; i++) lockout.recordFailure('admin', '198.51.100.1');
    advance(DEFAULT_LOCKOUT_POLICY.forgetAfterMs);
    expect(lockout.retryAfterMs('admin', '198.51.100.1')).toBe(0);
    expect(lockout.recordFailure('admin', '198.51.100.1').lockedForMs).toBe(0);

    for (let i = 0; i < 5; i++) lockout.recordFailure('bob', '198.51.100.9');
    lockout.recordFailure('carol', '198.51.100.9');
    lockout.recordFailure('dave', '198.51.100.9');
    // Capacity 2: the unlocked pairs went (admin, then carol); bob's running lock stayed.
    expect(lockout.retryAfterMs('bob', '198.51.100.9')).toBe(30_000);
  });

  it('keeps a locked pair while maxEntries + 1 other pairs fail from the same IP', () => {
    const maxEntries = 100;
    const { lockout } = setup({ ...DEFAULT_LOCKOUT_POLICY, maxEntries });
    for (let i = 0; i < 5; i++) lockout.recordFailure('admin', '198.51.100.1');
    for (let i = 0; i <= maxEntries; i++) lockout.recordFailure(`user${i}`, '198.51.100.1');
    expect(lockout.retryAfterMs('admin', '198.51.100.1')).toBe(30_000);
  });

  it('drops the oldest running lock only when every tracked pair holds one', () => {
    const { lockout } = setup({ ...DEFAULT_LOCKOUT_POLICY, threshold: 1, maxEntries: 2 });
    for (const name of ['amy', 'ben', 'cid']) lockout.recordFailure(name, '198.51.100.1');
    expect(lockout.retryAfterMs('amy', '198.51.100.1')).toBe(0);
    expect(lockout.retryAfterMs('ben', '198.51.100.1')).toBe(30_000);
    expect(lockout.retryAfterMs('cid', '198.51.100.1')).toBe(30_000);
  });
});

describe('LoginLockout IP budget', () => {
  it('gives each IP 10 sign-in attempts a minute; refusals spend nothing', () => {
    const { lockout, advance } = setup();
    for (let i = 0; i < 10; i++) expect(lockout.takeIpAttempt('198.51.100.1')).toBe(0);
    expect(lockout.takeIpAttempt('198.51.100.1')).toBe(60_000);
    expect(lockout.takeIpAttempt('198.51.100.2')).toBe(0);
    advance(59_000);
    // The refusals neither restarted nor extended the window.
    expect(lockout.takeIpAttempt('198.51.100.1')).toBe(1_000);
    advance(1_000);
    for (let i = 0; i < 10; i++) expect(lockout.takeIpAttempt('198.51.100.1')).toBe(0);
    expect(lockout.takeIpAttempt('198.51.100.1')).toBe(60_000);
  });

  it('bounds the number of tracked IPs, keeping spent budgets', () => {
    const { lockout } = setup({ ...DEFAULT_LOCKOUT_POLICY, ipAttempts: 2, maxEntries: 2 });
    lockout.takeIpAttempt('198.51.100.1');
    lockout.takeIpAttempt('198.51.100.1');
    for (let i = 2; i <= 5; i++) lockout.takeIpAttempt(`198.51.100.${i}`);
    expect(lockout.takeIpAttempt('198.51.100.1')).toBe(60_000);

    // When every tracked IP has spent its budget, the oldest one goes (the memory bound wins).
    const full = setup({ ...DEFAULT_LOCKOUT_POLICY, ipAttempts: 1, maxEntries: 2 }).lockout;
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) full.takeIpAttempt(ip);
    expect(full.takeIpAttempt('198.51.100.1')).toBe(0);
    expect(full.takeIpAttempt('198.51.100.3')).toBe(60_000);
  });
});
