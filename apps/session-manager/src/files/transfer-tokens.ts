import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type ServerMessage, TRANSFER_TOKEN_TTL_MS } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import type { AttachmentClient } from '../core/types.ts';

/** Unused transfer URLs one user may hold at once (each lives TRANSFER_TOKEN_TTL_MS). */
export const MAX_PENDING_TOKENS_PER_USER = 64;
/** A token: 32 random bytes, base64url. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type TransferDirection = 'upload' | 'download';

interface GrantBase {
  transferId: string;
  userId: string;
  /** The auth session that minted it: re-validated when the URL is used, revoked with it. */
  authSessionId: string;
  sessionId: string;
  /** Download: the size when minted; upload: the size the browser declared. */
  size: number;
  /** Sends to the connection that minted the URL (`transfer.progress`); dropped once it closed. */
  notify(message: ServerMessage): void;
  /** The minting connection's client, for the audit rows. */
  client: AttachmentClient;
}

/** What a transfer URL lets its holder do, fixed when it was minted (plan §5.12). */
export type TransferGrant = GrantBase &
  (
    | { direction: 'download'; path: string }
    | {
        direction: 'upload';
        /** The folder and the new file's name in it; `path` joins them. */
        dir: string;
        name: string;
        path: string;
        overwrite: boolean;
      }
  );

type WithoutId<T> = T extends unknown ? Omit<T, 'transferId'> : never;
/** A grant before it is minted (the transfer id comes with the token). */
export type TransferGrantInput = WithoutId<TransferGrant>;

interface Pending {
  grant: TransferGrant;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Single-use transfer URLs (plan §5.12): 32 random bytes each, valid TRANSFER_TOKEN_TTL_MS, bound
 * to their grant. Only a hash of the token is kept, so the map is no oracle for timing. A URL that
 * expires unused tells its minting connection (`transfer.progress` failed TRANSFER_EXPIRED): the
 * browser never started that transfer (a download prompt left unanswered, typically).
 */
export class TransferTokens {
  readonly #pending = new Map<string, Pending>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #maxPerUser: number;

  constructor(options: { ttlMs?: number; now?: () => number; maxPerUser?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? TRANSFER_TOKEN_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#maxPerUser = options.maxPerUser ?? MAX_PENDING_TOKENS_PER_USER;
  }

  /** Unused URLs not expired yet. */
  get size(): number {
    this.#expireDue();
    return this.#pending.size;
  }

  /** A new URL token for `input`; RATE_LIMITED while the user holds too many unused ones. */
  mint(input: TransferGrantInput): { token: string; grant: TransferGrant } {
    this.#expireDue();
    let held = 0;
    for (const { grant } of this.#pending.values()) if (grant.userId === input.userId) held++;
    if (held >= this.#maxPerUser) {
      throw new TermdockError(ErrorCode.RateLimited, 'too many unused transfer URLs');
    }
    const token = randomBytes(32).toString('base64url');
    const grant = { ...input, transferId: randomUUID() } as TransferGrant;
    const key = digest(token);
    const pending: Pending = { grant, expiresAt: this.#now() + this.#ttlMs, timer: undefined };
    this.#pending.set(key, pending);
    this.#arm(key, pending, this.#ttlMs);
    return { token, grant };
  }

  /**
   * The grant of a token used for `direction`, which spends it: null when it is unknown, used,
   * expired or minted for the other direction.
   */
  consume(token: string, direction: TransferDirection): TransferGrant | null {
    const key = digest(token);
    const pending = this.#pending.get(key);
    if (!pending) return null;
    if (pending.expiresAt <= this.#now()) {
      // Too late: the same as any expired URL (its connection hears about it now).
      this.#expireDue();
      return null;
    }
    this.#forget(key, pending);
    return pending.grant.direction === direction ? pending.grant : null;
  }

  /** Voids the user's unused URL of `transferId`; false when there is none. */
  void(userId: string, transferId: string): boolean {
    for (const [key, pending] of this.#pending) {
      if (pending.grant.transferId === transferId && pending.grant.userId === userId) {
        this.#forget(key, pending);
        return true;
      }
    }
    return false;
  }

  /** Voids every unused URL of a user or of an auth session; resolves how many. */
  revoke(target: { userId?: string; authSessionId?: string }): number {
    let voided = 0;
    for (const [key, pending] of this.#pending) {
      if (matches(pending.grant, target)) {
        this.#forget(key, pending);
        voided++;
      }
    }
    return voided;
  }

  /** Daemon shutdown: every unused URL is void, nobody is told. */
  clear(): void {
    for (const [key, pending] of this.#pending) this.#forget(key, pending);
  }

  /** Expires the URL when its lifetime is over (again later if the clock says it is not yet). */
  #arm(key: string, pending: Pending, delayMs: number): void {
    pending.timer = setTimeout(() => {
      if (this.#pending.get(key) !== pending) return;
      const left = pending.expiresAt - this.#now();
      if (left > 0) this.#arm(key, pending, left);
      else this.#expireDue();
    }, delayMs);
    pending.timer.unref();
  }

  #forget(key: string, pending: Pending): void {
    clearTimeout(pending.timer);
    this.#pending.delete(key);
  }

  /** Forgets the URLs past their lifetime, telling each minting connection. */
  #expireDue(): void {
    const now = this.#now();
    for (const [key, pending] of this.#pending) {
      if (pending.expiresAt > now) continue;
      this.#forget(key, pending);
      const { grant } = pending;
      try {
        grant.notify({
          type: 'transfer.progress',
          transferId: grant.transferId,
          bytes: 0,
          size: grant.size,
          state: 'failed',
          code: ErrorCode.TransferExpired,
        });
      } catch {
        // A connection that went away: nobody left to tell.
      }
    }
  }
}

/** A grant belongs to the revoked user or auth session (an empty target matches nothing). */
export function matches(
  grant: { userId: string; authSessionId: string },
  target: { userId?: string; authSessionId?: string },
): boolean {
  return (
    (target.userId !== undefined && grant.userId === target.userId) ||
    (target.authSessionId !== undefined && grant.authSessionId === target.authSessionId)
  );
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
