import './server-guard.ts';

/**
 * Keys whose values never reach the logs: the daemon's pino redaction list (tickets, prompt
 * answers, credential material, terminal bytes, profile environments and policies, HTTP auth
 * headers; apps/session-manager/src/config/logger.ts) and the web's own secrets. Code never
 * logs them on purpose; redaction is the safety net.
 */
export const REDACT_KEYS = [
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
] as const;

const CENSOR = '[redacted]';
const SECRET_KEYS = new Set<string>(REDACT_KEYS.map((key) => key.toLowerCase()));
const isSecret = (key: string): boolean => SECRET_KEYS.has(key.toLowerCase());
/** `"key": value` pairs of a JSON text embedded in a message (an error body, a dumped object). */
const JSON_PAIR = new RegExp(
  `"(${REDACT_KEYS.join('|')})"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|[^\\s,}\\]]+)`,
  'gi',
);

/** Minimal logger seam (pino arrives with the rest of the web logging; plan T-11). */
export interface WebLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** `fields` with the values of REDACT_KEYS censored at the top level and one level down. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const censor = (key: string, value: unknown): unknown => (isSecret(key) ? CENSOR : value);
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (isSecret(key)) return [key, CENSOR];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [key, value];
      const nested = Object.entries(value as Record<string, unknown>);
      return [key, Object.fromEntries(nested.map(([k, v]) => [k, censor(k, v)]))];
    }),
  );
}

/** A message with the values of REDACT_KEYS censored wherever it embeds JSON. */
export function redactMessage(message: string): string {
  return message.replace(JSON_PAIR, (_pair, key: string) => `"${key}":"${CENSOR}"`);
}

function line(message: string, fields?: Record<string, unknown>): string {
  const text = redactMessage(message);
  return fields ? `${text} ${JSON.stringify(redactFields(fields))}` : text;
}

export const consoleLogger: WebLogger = {
  info: (message, fields) => console.info(`[termdock] ${line(message, fields)}`),
  warn: (message, fields) => console.warn(`[termdock] WARN ${line(message, fields)}`),
  error: (message, fields) => console.error(`[termdock] ERROR ${line(message, fields)}`),
};
