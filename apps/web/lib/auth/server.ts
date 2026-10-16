import 'server-only';
import { openDb } from '@termdock/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadWebConfig, readSecretFileSync, secretBytes } from '../config.ts';
import type { AuthSession } from './auth.ts';
import { authGate, type GateOptions } from './gate.ts';
import { type AuthRuntime, createAuthRuntime } from './runtime.ts';
import type { SetupInput } from './setup.ts';

/**
 * Next-facing entry of the auth core. The runtime is built lazily on first use (never at import,
 * so `next build` needs no secrets) and kept on globalThis, because Next can load a server module
 * once per bundle layer and the setup token and lockout state must be process-wide.
 */
const holder = globalThis as unknown as { __termdockAuthRuntime?: AuthRuntime };

export function getAuthRuntime(): AuthRuntime {
  holder.__termdockAuthRuntime ??= buildRuntimeFromEnv();
  return holder.__termdockAuthRuntime;
}

function buildRuntimeFromEnv(): AuthRuntime {
  const config = loadWebConfig();
  return createAuthRuntime({
    db: openDb(config.dbFile),
    publicUrl: config.publicUrl,
    authSecret: readSecretFileSync(config.betterAuthSecretFile),
    wsSecret: secretBytes(readSecretFileSync(config.wsSecretFile)),
  });
}

/**
 * The gate for pages and Server Actions: returns the session or redirects (login, setup,
 * forced password change, TOTP enrollment).
 */
export async function requireSession(options?: GateOptions): Promise<AuthSession> {
  const result = await authGate(getAuthRuntime(), await headers(), options);
  if (!result.ok) redirect(result.redirectTo);
  return { session: result.session, user: result.user };
}

export function isSetupOpen(): boolean {
  return getAuthRuntime().setup.isOpen();
}

export function completeSetup(token: string, input: SetupInput): Promise<{ userId: string }> {
  return getAuthRuntime().setup.complete(token, input);
}
