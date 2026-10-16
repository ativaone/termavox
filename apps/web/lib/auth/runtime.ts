import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';
import { consoleLogger, type WebLogger } from '../logger.ts';
import { createAuth, type TermdockAuth } from './auth.ts';
import { type LockoutPolicy, LoginLockout } from './lockout.ts';
import type { Argon2Params } from './password.ts';
import { SetupToken } from './setup.ts';

/** Everything the auth core needs, built once per process (lib/auth/server.ts) or per test. */
export interface AuthRuntime {
  db: TermdockDb;
  auth: TermdockAuth;
  lockout: LoginLockout;
  setup: SetupToken;
  /** Origin of TERMDOCK_PUBLIC_URL, compared exactly with the `Origin` header. */
  publicOrigin: string;
  /** WS ticket HMAC key: TERMDOCK_WS_SECRET_FILE's trimmed content as UTF-8 bytes. */
  wsSecret: Uint8Array;
  logger: WebLogger;
}

export interface CreateAuthRuntimeOptions {
  db: TermdockDb;
  publicUrl: string;
  authSecret: string;
  wsSecret: Uint8Array;
  logger?: WebLogger;
  argon2?: Argon2Params;
  rateLimit?: boolean;
  lockoutPolicy?: LockoutPolicy;
}

export function createAuthRuntime(options: CreateAuthRuntimeOptions): AuthRuntime {
  const logger = options.logger ?? consoleLogger;
  const lockout = new LoginLockout(options.lockoutPolicy);
  const auth = createAuth({
    db: options.db,
    publicUrl: options.publicUrl,
    secret: options.authSecret,
    lockout,
    logger,
    ...(options.argon2 ? { argon2: options.argon2 } : {}),
    ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
  });
  const setup = new SetupToken({
    db: options.db,
    auth,
    logger,
    setupUrl: new URL('/setup', options.publicUrl).href,
  });
  setup.initialize();
  return {
    db: options.db,
    auth,
    lockout,
    setup,
    publicOrigin: new URL(options.publicUrl).origin,
    wsSecret: options.wsSecret,
    logger,
  };
}
