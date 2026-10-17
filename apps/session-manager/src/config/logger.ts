import { type Logger, pino } from 'pino';

export type { Logger };

/**
 * Keys that must never reach the logs (tickets, keystrokes, prompt answers, credential
 * material, server environments and policies, which often hold API keys, and HTTP auth
 * headers). Code never logs them on purpose; redaction is the safety net. The web logger keeps
 * the same list (apps/web/lib/logger.ts).
 */
export const REDACT_PATHS = [
  'ticket',
  'answers',
  'password',
  'passphrase',
  'privateKey',
  'secret',
  'payload',
  'data',
  'input',
  'env',
  'policies',
  'authorization',
  'cookie',
  'token',
  '*.ticket',
  '*.answers',
  '*.password',
  '*.passphrase',
  '*.privateKey',
  '*.secret',
  '*.payload',
  '*.data',
  '*.input',
  '*.env',
  '*.authorization',
  '*.cookie',
  '*.token',
];

export function createLogger(level: string, name = 'session-manager'): Logger {
  return pino({ name, level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
