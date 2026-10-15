import { type Logger, pino } from 'pino';

export type { Logger };

/**
 * Keys that must never reach the logs (tickets, keystrokes, prompt answers, credential
 * material). Code never logs them on purpose; redaction is the safety net.
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
  '*.ticket',
  '*.answers',
  '*.password',
  '*.passphrase',
  '*.privateKey',
  '*.secret',
  '*.payload',
  '*.data',
  '*.input',
];

export function createLogger(level: string, name = 'session-manager'): Logger {
  return pino({ name, level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
