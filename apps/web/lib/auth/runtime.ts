import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';
import type { Argon2Params } from '@termavox/shared';
import { consoleLogger, type WebLogger } from '../logger.ts';
import { createAuth, type TermavoxAuth } from './auth.ts';
import { type LockoutPolicy, LoginLockout } from './lockout.ts';
import { SetupToken } from './setup.ts';

/** Everything the auth core needs, built once per process (lib/auth/server.ts) or per test. */
export interface AuthRuntime {
  db: TermavoxDb;
  auth: TermavoxAuth;
  lockout: LoginLockout;
  setup: SetupToken;
  /** Origin of TERMAVOX_PUBLIC_URL, compared exactly with the `Origin` header. */
  publicOrigin: string;
  /** WS ticket HMAC key: TERMAVOX_WS_SECRET_FILE's trimmed content as UTF-8 bytes. */
  wsSecret: Uint8Array;
  logger: WebLogger;
}

export interface CreateAuthRuntimeOptions {
  db: TermavoxDb;
  publicUrl: string;
  authSecret: string;
  wsSecret: Uint8Array;
  logger?: WebLogger;
  argon2?: Argon2Params;
  rateLimit?: boolean;
  lockoutPolicy?: LockoutPolicy;
  /** The lockout's clock; tests move it instead of waiting. */
  lockoutNow?: () => number;
}

export function createAuthRuntime(options: CreateAuthRuntimeOptions): AuthRuntime {
  const logger = options.logger ?? consoleLogger;
  const lockout = new LoginLockout(options.lockoutPolicy, options.lockoutNow);
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
