import { describe, expect, it } from 'vitest';
import { DEFAULT_ARGON2_PARAMS, hashPassword, verifyPassword } from '../lib/auth/password.ts';

describe('argon2id password hashing', () => {
  it('hashes to a PHC string with the production parameters and verifies it', async () => {
    const hash = await hashPassword('correct horse battery');
    const { memoryKiB, passes, parallelism } = DEFAULT_ARGON2_PARAMS;
    expect(hash).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${memoryKiB},t=${passes},p=${parallelism}\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$`,
      ),
    );
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batterY')).toBe(false);
  });

  it('treats malformed or out-of-bounds hashes as a mismatch', async () => {
    const salt = 'c2FsdHNhbHRzYWx0c2FsdA';
    const tag = 'dGFnLXRhZy10YWctdGFnLXRhZy10YWctdGFnLXRhZy0';
    expect(await verifyPassword('', 'x')).toBe(false);
    expect(await verifyPassword('scrypt:abc:def', 'x')).toBe(false);
    expect(await verifyPassword(`$argon2id$v=19$m=999999999,t=1,p=1$${salt}$${tag}`, 'x')).toBe(
      false,
    );
    expect(await verifyPassword(`$argon2i$v=19$m=1024,t=1,p=1$${salt}$${tag}`, 'x')).toBe(false);
  });
});
