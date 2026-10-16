import type { TermdockDb } from '@termdock/db';
import { uuidv7 } from '@termdock/shared';
import type { TransportFactory, TransportHooks } from '../core/transport-factory.ts';
import type { HostKeyStore, PresentedHostKey, SessionRecord, Transport } from '../core/types.ts';
import { insertAudit } from './audit.ts';
import type { BatchedWriter } from './batched-writer.ts';
import { allRows, execute, getRow, type Sqlite } from './sqlite.ts';

/** A pending key can be trusted for 24 h after it was first seen (plan §5.9). */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export type HostKeyStatus = 'trusted' | 'pending' | 'revoked';

interface KeyRow {
  id: string;
  key_type: string;
  public_key_b64: string | null;
  fingerprint_sha256: string;
  status: HostKeyStatus;
  first_seen_at: number;
  decided_by: string | null;
  decided_at: number | null;
}

export interface HostKeyEntry {
  id: string;
  keyType: string;
  /** Null for a pasted pre-trust fingerprint that was never seen on the wire. */
  publicKeyB64: string | null;
  fingerprint: string;
  status: HostKeyStatus;
  firstSeenAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  /** Pending rows only: past the 24 h window, so it can no longer be trusted. */
  expired: boolean;
}

/**
 * - `trusted`: trusted now (pending key or pasted fingerprint).
 * - `already_trusted`: that exact key was already trusted (idempotent).
 * - `no_match`: no unexpired pending key with that fingerprint (and pre-trust not allowed).
 * - `conflict`: a different key of that type is trusted; only replace-key may change it.
 * - `revoked`: the owner revoked that key for the host; only replace-key may trust it again.
 */
export type TrustOutcome = 'trusted' | 'already_trusted' | 'no_match' | 'conflict' | 'revoked';

const COLUMNS =
  'id, key_type, public_key_b64, fingerprint_sha256, status, first_seen_at, decided_by, decided_at';

/**
 * Host-key trust store over `known_host_keys` (the daemon writes every row, plan §9).
 * Invariants: at most one `trusted` row per host and key type (also enforced by the partial
 * unique index; handled here so it never surfaces as a constraint error); pending rows expire
 * 24 h after `first_seen_at`; a revoked fingerprint is never recorded as pending nor trusted
 * again except through replace-key; every pending/trust/replace/revoke/mismatch (and a revoked
 * key presented again) writes an `audit_events` row in the same transaction.
 */
export class SqliteHostKeyStore implements HostKeyStore {
  readonly #sqlite: Sqlite;
  readonly #writer: BatchedWriter;
  readonly #now: () => number;

  constructor(db: TermdockDb, writer: BatchedWriter, options: { now?: () => number } = {}) {
    this.#sqlite = db.$client;
    this.#writer = writer;
    this.#now = options.now ?? Date.now;
  }

  async trusted(hostId: string): Promise<Map<string, PresentedHostKey>> {
    const rows = allRows<KeyRow>(
      this.#sqlite,
      `SELECT ${COLUMNS} FROM known_host_keys WHERE host_id = ? AND status = 'trusted'`,
      hostId,
    );
    return new Map(
      rows.map((r) => [
        r.key_type,
        {
          type: r.key_type,
          fingerprint: r.fingerprint_sha256,
          publicKeyB64: r.public_key_b64 ?? '',
        },
      ]),
    );
  }

  /** Fingerprints of the host's revoked keys (decided against with the trusted ones). */
  async revoked(hostId: string): Promise<Set<string>> {
    const rows = allRows<{ fingerprint_sha256: string }>(
      this.#sqlite,
      `SELECT DISTINCT fingerprint_sha256 FROM known_host_keys WHERE host_id = ? AND status = 'revoked'`,
      hostId,
    );
    return new Set(rows.map((r) => r.fingerprint_sha256));
  }

  /**
   * Records a presented unknown key as pending (keeps `first_seen_at` of an existing one). A
   * revoked fingerprint is never recorded: it is not unknown, and no prompt may offer it.
   */
  recordPending(hostId: string, key: PresentedHostKey): Promise<void> {
    return this.#writer.run('host_key.pending', (sqlite) => {
      const now = this.#now();
      if (this.#isRevoked(sqlite, hostId, key.fingerprint)) return;
      execute(
        sqlite,
        "DELETE FROM known_host_keys WHERE host_id = ? AND status = 'pending' AND first_seen_at <= ?",
        hostId,
        now - PENDING_TTL_MS,
      );
      const existing = getRow(
        sqlite,
        `SELECT id FROM known_host_keys
          WHERE host_id = ? AND status = 'pending' AND key_type = ? AND fingerprint_sha256 = ?`,
        hostId,
        key.type,
        key.fingerprint,
      );
      if (existing) return;
      execute(
        sqlite,
        `INSERT INTO known_host_keys (id, host_id, key_type, public_key_b64, fingerprint_sha256, status, first_seen_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        uuidv7(now),
        hostId,
        key.type,
        key.publicKeyB64,
        key.fingerprint,
        now,
      );
      insertAudit(sqlite, {
        type: 'host_key.pending',
        actorUserId: null,
        targetType: 'host',
        targetId: hostId,
        detail: { keyType: key.type, fingerprint: key.fingerprint },
        at: now,
      });
    });
  }

  /**
   * In-flow decision (`hostkey.decision`): trusts exactly the pending key, never a pasted one,
   * and never a revoked one.
   */
  async trustPending(hostId: string, fingerprint: string, decidedBy: string): Promise<boolean> {
    const outcome = await this.trust(hostId, { fingerprint, decidedBy, allowPreTrust: false });
    return outcome === 'trusted' || outcome === 'already_trusted';
  }

  /**
   * Fills `public_key_b64` of the trusted row of a pasted pre-trust fingerprint (NULL until the
   * key is first seen) once a presented key matched it (plan §9). No other row changes.
   */
  rememberPublicKey(hostId: string, key: PresentedHostKey): Promise<void> {
    return this.#writer.run('host_key.public_key', (sqlite) => {
      execute(
        sqlite,
        `UPDATE known_host_keys SET public_key_b64 = ?
          WHERE host_id = ? AND key_type = ? AND fingerprint_sha256 = ? AND status = 'trusted'
            AND public_key_b64 IS NULL`,
        key.publicKeyB64,
        hostId,
        key.type,
        key.fingerprint,
      );
    });
  }

  /**
   * Internal API `trust-key`: trusts the unexpired pending key with that fingerprint (and key
   * type, when given); without one and with `allowPreTrust`, records the pasted (normalized)
   * fingerprint as trusted (`public_key_b64` NULL).
   */
  trust(
    hostId: string,
    opts: { fingerprint: string; keyType?: string; decidedBy: string; allowPreTrust: boolean },
  ): Promise<TrustOutcome> {
    return this.#writer.run('host_key.trust', (sqlite): TrustOutcome => {
      const now = this.#now();
      const pending = this.#pending(sqlite, hostId, opts.fingerprint, opts.keyType, now);
      if (!pending && !opts.allowPreTrust) return 'no_match';
      const keyType = pending?.key_type ?? opts.keyType;
      if (!keyType) return 'no_match';
      const current = this.#trustedRow(sqlite, hostId, keyType);
      if (current?.fingerprint_sha256 === opts.fingerprint) {
        if (pending) {
          if (current.public_key_b64 === null) {
            execute(
              sqlite,
              'UPDATE known_host_keys SET public_key_b64 = ? WHERE id = ?',
              pending.public_key_b64,
              current.id,
            );
          }
          execute(sqlite, 'DELETE FROM known_host_keys WHERE id = ?', pending.id);
        }
        return 'already_trusted';
      }
      // A revoked key comes back only through replace-key (explicit and name-confirmed).
      if (this.#isRevoked(sqlite, hostId, opts.fingerprint)) return 'revoked';
      if (current) return 'conflict';
      this.#promote(sqlite, hostId, keyType, opts.fingerprint, pending, opts.decidedBy, now);
      insertAudit(sqlite, {
        type: 'host_key.trust',
        actorUserId: opts.decidedBy,
        targetType: 'host',
        targetId: hostId,
        detail: { keyType, fingerprint: opts.fingerprint, source: pending ? 'pending' : 'pasted' },
        at: now,
      });
      return 'trusted';
    });
  }

  /**
   * Internal API `replace-key` (after a mismatch): revokes the trusted key of that type and
   * trusts the given fingerprint (the pending key with it, if any, else as pasted).
   */
  replace(hostId: string, keyType: string, fingerprint: string, decidedBy: string): Promise<void> {
    return this.#writer.run('host_key.replace', (sqlite) => {
      const now = this.#now();
      const current = this.#trustedRow(sqlite, hostId, keyType);
      if (current?.fingerprint_sha256 === fingerprint) return;
      if (current) {
        execute(
          sqlite,
          "UPDATE known_host_keys SET status = 'revoked', decided_by = ?, decided_at = ? WHERE id = ?",
          decidedBy,
          now,
          current.id,
        );
      }
      const pending = this.#pending(sqlite, hostId, fingerprint, keyType, now);
      this.#promote(sqlite, hostId, keyType, fingerprint, pending, decidedBy, now);
      insertAudit(sqlite, {
        type: 'host_key.replace',
        actorUserId: decidedBy,
        targetType: 'host',
        targetId: hostId,
        detail: {
          keyType,
          previousFingerprint: current?.fingerprint_sha256 ?? null,
          fingerprint,
          source: pending ? 'pending' : 'pasted',
        },
        at: now,
      });
    });
  }

  /** Internal API `revoke-key`: false when no key of that type is trusted. */
  revoke(hostId: string, keyType: string, decidedBy: string): Promise<boolean> {
    return this.#writer.run('host_key.revoke', (sqlite) => {
      const now = this.#now();
      const current = this.#trustedRow(sqlite, hostId, keyType);
      if (!current) return false;
      execute(
        sqlite,
        "UPDATE known_host_keys SET status = 'revoked', decided_by = ?, decided_at = ? WHERE id = ?",
        decidedBy,
        now,
        current.id,
      );
      insertAudit(sqlite, {
        type: 'host_key.revoke',
        actorUserId: decidedBy,
        targetType: 'host',
        targetId: hostId,
        detail: { keyType, fingerprint: current.fingerprint_sha256 },
        at: now,
      });
      return true;
    });
  }

  /**
   * Audits a host-key mismatch (a trusted key exists and the server presented another). The
   * actor is the user whose connection observed it.
   */
  recordMismatch(
    hostId: string,
    presented: { type: string; fingerprint: string },
    actorUserId: string | null,
    detail: Record<string, unknown> = {},
  ): void {
    const at = this.#now();
    this.#writer.enqueue('host_key.mismatch', (sqlite) => {
      insertAudit(sqlite, {
        type: 'host_key.mismatch',
        actorUserId,
        targetType: 'host',
        targetId: hostId,
        detail: { keyType: presented.type, fingerprint: presented.fingerprint, ...detail },
        at,
      });
    });
  }

  /**
   * Audits a server presenting a key the owner revoked for the host (refused like a mismatch).
   * The actor is the user whose connection observed it.
   */
  recordRevokedPresented(
    hostId: string,
    presented: { type: string; fingerprint: string },
    actorUserId: string | null,
    detail: Record<string, unknown> = {},
  ): void {
    const at = this.#now();
    this.#writer.enqueue('host_key.revoked_presented', (sqlite) => {
      insertAudit(sqlite, {
        type: 'host_key.revoked_presented',
        actorUserId,
        targetType: 'host',
        targetId: hostId,
        detail: { keyType: presented.type, fingerprint: presented.fingerprint, ...detail },
        at,
      });
    });
  }

  /** Every key row of a host (newest first), with pending expiry resolved. */
  async list(hostId: string): Promise<HostKeyEntry[]> {
    const now = this.#now();
    return allRows<KeyRow>(
      this.#sqlite,
      `SELECT ${COLUMNS} FROM known_host_keys WHERE host_id = ? ORDER BY first_seen_at DESC, id DESC`,
      hostId,
    ).map((r) => ({
      id: r.id,
      keyType: r.key_type,
      publicKeyB64: r.public_key_b64,
      fingerprint: r.fingerprint_sha256,
      status: r.status,
      firstSeenAt: r.first_seen_at,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      expired: r.status === 'pending' && r.first_seen_at <= now - PENDING_TTL_MS,
    }));
  }

  #pending(
    sqlite: Sqlite,
    hostId: string,
    fingerprint: string,
    keyType: string | undefined,
    now: number,
  ): KeyRow | undefined {
    return getRow<KeyRow>(
      sqlite,
      `SELECT ${COLUMNS} FROM known_host_keys
        WHERE host_id = ? AND status = 'pending' AND fingerprint_sha256 = ?
          AND (? IS NULL OR key_type = ?) AND first_seen_at > ?
        ORDER BY first_seen_at DESC LIMIT 1`,
      hostId,
      fingerprint,
      keyType ?? null,
      keyType ?? null,
      now - PENDING_TTL_MS,
    );
  }

  #isRevoked(sqlite: Sqlite, hostId: string, fingerprint: string): boolean {
    return (
      getRow(
        sqlite,
        `SELECT 1 AS revoked FROM known_host_keys
          WHERE host_id = ? AND status = 'revoked' AND fingerprint_sha256 = ? LIMIT 1`,
        hostId,
        fingerprint,
      ) !== undefined
    );
  }

  #trustedRow(sqlite: Sqlite, hostId: string, keyType: string): KeyRow | undefined {
    return getRow<KeyRow>(
      sqlite,
      `SELECT ${COLUMNS} FROM known_host_keys WHERE host_id = ? AND key_type = ? AND status = 'trusted'`,
      hostId,
      keyType,
    );
  }

  /** Makes `pending` (or a new pasted row) the trusted key; drops other pending rows of that type. */
  #promote(
    sqlite: Sqlite,
    hostId: string,
    keyType: string,
    fingerprint: string,
    pending: KeyRow | undefined,
    decidedBy: string,
    now: number,
  ): void {
    if (pending) {
      execute(
        sqlite,
        "UPDATE known_host_keys SET status = 'trusted', decided_by = ?, decided_at = ? WHERE id = ?",
        decidedBy,
        now,
        pending.id,
      );
    } else {
      execute(
        sqlite,
        `INSERT INTO known_host_keys (id, host_id, key_type, public_key_b64, fingerprint_sha256, status,
           first_seen_at, decided_by, decided_at)
         VALUES (?, ?, ?, NULL, ?, 'trusted', ?, ?, ?)`,
        uuidv7(now),
        hostId,
        keyType,
        fingerprint,
        now,
        decidedBy,
        now,
      );
    }
    execute(
      sqlite,
      "DELETE FROM known_host_keys WHERE host_id = ? AND key_type = ? AND status = 'pending'",
      hostId,
      keyType,
    );
  }
}

/**
 * Wraps a transport factory so that every host-key mismatch (and revoked key) observed during a
 * session's handshake is audited (the runtime records it as a session event; the audit log
 * needs it too).
 */
export function auditHostKeyMismatches(
  inner: TransportFactory,
  hostKeys: SqliteHostKeyStore,
): TransportFactory {
  return {
    create(record: SessionRecord, hooks: TransportHooks): Promise<Transport> {
      return inner.create(record, {
        onHostKey(key, decision) {
          const hostId = record.target.hostId;
          if (decision === 'mismatch' && hostId) {
            hostKeys.recordMismatch(hostId, key, record.userId, { sessionId: record.id });
          }
          if (decision === 'revoked' && hostId) {
            hostKeys.recordRevokedPresented(hostId, key, record.userId, { sessionId: record.id });
          }
          hooks.onHostKey(key, decision);
        },
        onKeyboardInteractive: (request) => hooks.onKeyboardInteractive(request),
      });
    },
  };
}
