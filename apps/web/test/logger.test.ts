import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger, REDACT_KEYS, redactFields, redactMessage } from '../lib/logger.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web logger redaction (I3)', () => {
  it('censors the daemon list plus password, secret and passphrase', () => {
    for (const key of ['env', 'policies', 'authorization', 'cookie', 'token', 'password']) {
      expect(REDACT_KEYS).toContain(key);
    }
    for (const key of ['secret', 'passphrase', 'privateKey', 'ticket', 'answers']) {
      expect(REDACT_KEYS).toContain(key);
    }
    expect(
      redactFields({
        userId: 'u1',
        password: 'p@ss',
        Authorization: 'Bearer t',
        headers: { cookie: 'a=b', 'user-agent': 'Firefox' },
        profile: { env: { API_KEY: 'k' }, name: 'prod' },
        list: ['token'],
      }),
    ).toEqual({
      userId: 'u1',
      password: '[redacted]',
      Authorization: '[redacted]',
      headers: { cookie: '[redacted]', 'user-agent': 'Firefox' },
      profile: { env: '[redacted]', name: 'prod' },
      list: ['token'],
    });
  });

  it('censors secret values in JSON embedded in messages, and nothing else', () => {
    const message =
      'better-auth: {"token":"abc\\"def","user":{"password": "hunter2","name":"ann"},"secret":12}';
    expect(redactMessage(message)).toBe(
      'better-auth: {"token":"[redacted]","user":{"password":"[redacted]","name":"ann"},"secret":"[redacted]"}',
    );
    // Prose stays as written (the one-time setup token line is deliberate).
    const setup =
      'Create the first admin at https://t.test/setup with this one-time setup token: XYZ';
    expect(redactMessage(setup)).toBe(setup);
  });

  it('applies both to what reaches the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogger.warn('failed {"cookie":"session=1"}', { token: 't', status: 401 });
    expect(warn).toHaveBeenCalledWith(
      '[termdock] WARN failed {"cookie":"[redacted]"} {"token":"[redacted]","status":401}',
    );
  });
});
