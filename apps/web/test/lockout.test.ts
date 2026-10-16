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

  it('forgets a quiet pair and bounds the number of tracked pairs', () => {
    const { lockout, advance } = setup({ ...DEFAULT_LOCKOUT_POLICY, maxEntries: 2 });
    for (let i = 0; i < 5; i++) lockout.recordFailure('admin', '198.51.100.1');
    advance(DEFAULT_LOCKOUT_POLICY.forgetAfterMs);
    expect(lockout.retryAfterMs('admin', '198.51.100.1')).toBe(0);
    expect(lockout.recordFailure('admin', '198.51.100.1').lockedForMs).toBe(0);

    for (let i = 0; i < 5; i++) lockout.recordFailure('bob', '198.51.100.9');
    lockout.recordFailure('carol', '198.51.100.9');
    lockout.recordFailure('dave', '198.51.100.9');
    // Capacity 2: the least recently failed pairs (admin, then bob) were dropped.
    expect(lockout.retryAfterMs('bob', '198.51.100.9')).toBe(0);
  });
});
