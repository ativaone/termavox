import '../server-guard.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TermdockDb } from '@termdock/db';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { isAPIError } from 'better-auth/api';
import { z } from 'zod';
import type { WebLogger } from '../logger.ts';
import type { TermdockAuth } from './auth.ts';
import { hasAnyUser } from './queries.ts';

export const SetupInput = z.object({
  username: z.string().trim().min(3).max(30),
  email: z.email(),
  password: z.string().min(12).max(128),
});
export type SetupInput = z.infer<typeof SetupInput>;

interface SetupDeps {
  db: TermdockDb;
  auth: TermdockAuth;
  logger: WebLogger;
  /** Absolute URL of the setup page, printed with the token. */
  setupUrl: string;
}

/**
 * First-run setup (plan §8.1). While no user exists, `initialize` generates a one-time token and
 * logs it once at WARN; only its SHA-256 stays in memory. `complete` creates the first admin and
 * closes setup for good: no token is generated once any user exists, even after a restart.
 */
export class SetupToken {
  readonly #deps: SetupDeps;
  #hash: Buffer | null = null;
  #busy = false;

  constructor(deps: SetupDeps) {
    this.#deps = deps;
  }

  initialize(): void {
    if (this.#hash || hasAnyUser(this.#deps.db)) return;
    const token = randomBytes(24).toString('base64url');
    this.#hash = sha256(token);
    // The one deliberate secret in the logs: shown once, only while the instance has no user.
    this.#deps.logger.warn(
      `No user exists yet. Create the first admin at ${this.#deps.setupUrl} with this one-time setup token: ${token}`,
    );
  }

  isOpen(): boolean {
    if (this.#hash && hasAnyUser(this.#deps.db)) this.#hash = null;
    return this.#hash !== null;
  }

  /** Throws TermdockError: NOT_FOUND (closed), FORBIDDEN (token), CONFLICT (busy), BAD_REQUEST. */
  async complete(token: string, input: SetupInput): Promise<{ userId: string }> {
    if (!this.isOpen()) throw new TermdockError(ErrorCode.NotFound, 'setup is closed');
    if (!this.#matches(token)) throw new TermdockError(ErrorCode.Forbidden, 'invalid setup token');
    if (this.#busy) throw new TermdockError(ErrorCode.Conflict, 'setup is already in progress');
    const parsed = SetupInput.safeParse(input);
    if (!parsed.success) {
      throw new TermdockError(
        ErrorCode.BadRequest,
        parsed.error.issues[0]?.message ?? 'invalid input',
      );
    }
    const { username, email, password } = parsed.data;
    this.#busy = true;
    try {
      // No headers: a trusted server-side call, which the admin plugin allows without a session.
      const { user } = await this.#deps.auth.api.createUser({
        body: { email, password, name: username, role: 'admin', data: { username } },
      });
      this.#hash = null;
      this.#deps.logger.info('first admin created; setup is closed');
      return { userId: user.id };
    } catch (err) {
      if (isAPIError(err)) throw new TermdockError(ErrorCode.BadRequest, err.message);
      throw err;
    } finally {
      this.#busy = false;
    }
  }

  #matches(token: string): boolean {
    return this.#hash !== null && timingSafeEqual(sha256(token), this.#hash);
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
