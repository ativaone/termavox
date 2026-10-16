import './server-guard.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Web process environment (plan §13.2). Secrets are passed as file paths, never as values. */
const Env = z.object({
  TERMDOCK_PUBLIC_URL: z.url({ protocol: /^https?$/ }),
  TERMDOCK_DATA_DIR: z.string().min(1).default('/data'),
  BETTER_AUTH_SECRET_FILE: z.string().min(1),
  TERMDOCK_WS_SECRET_FILE: z.string().min(1),
  TERMDOCK_INTERNAL_URL: z.url({ protocol: /^https?$/ }),
  TERMDOCK_INTERNAL_TOKEN_FILE: z.string().min(1),
});

export interface WebConfig {
  publicUrl: string;
  /** What browsers send as `Origin`; route handlers compare it exactly. */
  publicOrigin: string;
  dataDir: string;
  /** Shared SQLite database (`<data dir>/app.db`), migrated by session-manager. */
  dbFile: string;
  betterAuthSecretFile: string;
  wsSecretFile: string;
  internalUrl: string;
  internalTokenFile: string;
}

/** Parses the environment; throws a readable error listing every invalid variable. */
export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration: ${issues.join('; ')}`);
  }
  const e = parsed.data;
  return {
    publicUrl: e.TERMDOCK_PUBLIC_URL,
    publicOrigin: new URL(e.TERMDOCK_PUBLIC_URL).origin,
    dataDir: e.TERMDOCK_DATA_DIR,
    dbFile: join(e.TERMDOCK_DATA_DIR, 'app.db'),
    betterAuthSecretFile: e.BETTER_AUTH_SECRET_FILE,
    wsSecretFile: e.TERMDOCK_WS_SECRET_FILE,
    internalUrl: e.TERMDOCK_INTERNAL_URL,
    internalTokenFile: e.TERMDOCK_INTERNAL_TOKEN_FILE,
  };
}

/**
 * Reads a secret file the way session-manager does (`readSecretFile` in its config): the trimmed
 * content is the secret. Callers that need key bytes (the WS ticket HMAC key) use
 * {@link secretBytes}; the content is never base64-decoded.
 */
export function readSecretFileSync(path: string, minLength = 32): string {
  const value = readFileSync(path, 'utf8').trim();
  if (value.length < minLength) {
    throw new Error(`secret file ${path} is shorter than ${minLength} characters`);
  }
  return value;
}

/** The secret as UTF-8 bytes: the WS ticket HMAC key shared with session-manager. */
export function secretBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
