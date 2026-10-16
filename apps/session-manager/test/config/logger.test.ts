import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loadDaemonConfig } from '../../src/config/config.ts';
import { REDACT_PATHS } from '../../src/config/logger.ts';

describe('daemon logging', () => {
  it('redacts profile environments, policies, auth headers, cookies and tokens (I3)', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info(
      {
        sessionId: 's1',
        env: { API_KEY: 'secret-1' },
        policies: { startupCommand: 'deploy --token secret-2' },
        authorization: 'Bearer secret-3',
        cookie: 'termdock.session=secret-4',
        token: 'secret-5',
        record: { env: { DB_PASSWORD: 'secret-6' }, token: 'secret-7' },
        req: { authorization: 'Bearer secret-8', cookie: 'a=secret-9' },
      },
      'session event',
    );
    const line = lines.join('');
    expect(line).not.toMatch(/secret-\d/);
    expect(JSON.parse(line)).toMatchObject({
      sessionId: 's1',
      env: '[redacted]',
      policies: '[redacted]',
      record: { env: '[redacted]', token: '[redacted]' },
      req: { authorization: '[redacted]', cookie: '[redacted]' },
    });
  });

  it('TERMDOCK_SSH_ALLOW_LOCAL_TARGETS defaults to false and parses like the other flags (L4)', () => {
    const env = {
      TERMDOCK_PUBLIC_URL: 'https://termdock.test',
      TERMDOCK_WS_SECRET_FILE: '/run/secrets/ws_secret',
      TERMDOCK_MASTER_KEY_FILE: '/run/secrets/master_key',
      TERMDOCK_INTERNAL_TOKEN_FILE: '/run/secrets/internal_token',
    };
    expect(loadDaemonConfig(env).sshAllowLocalTargets).toBe(false);
    for (const [value, expected] of [
      ['true', true],
      ['1', true],
      ['false', false],
      ['0', false],
      ['', false],
    ] as const) {
      const config = loadDaemonConfig({ ...env, TERMDOCK_SSH_ALLOW_LOCAL_TARGETS: value });
      expect(config.sshAllowLocalTargets).toBe(expected);
    }
    expect(() => loadDaemonConfig({ ...env, TERMDOCK_SSH_ALLOW_LOCAL_TARGETS: 'yes' })).toThrow(
      /TERMDOCK_SSH_ALLOW_LOCAL_TARGETS/,
    );
  });
});
