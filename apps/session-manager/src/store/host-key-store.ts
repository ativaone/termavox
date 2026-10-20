import type { TermavoxDb } from '@termavox/db';
import { normalizeHostname, uuidv7 } from '@termavox/shared';
import type { TransportFactory, TransportHooks } from '../core/transport-factory.ts';
import {
  type HostKeyAddress,
  type HostKeyStore,
  type HostKeyTarget,
  type PresentedHostKey,
  type SessionRecord,
  sessionHostKeyTarget,
  type Transport,
} from '../core/types.ts';
import { type DaemonAuditType, insertAudit } from './audit.ts';
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
 * - `already_trusted`: that exact key is already trusted for the address (idempotent), e.g. a
 *   prompt that another session of the address answered first (its pending row is gone).
 * - `no_match`: no unexpired pending key with that fingerprint (and pre-trust not allowed).
 * - `conflict`: a different key of that type is trusted; only replace-key may change it.
 * - `revoked`: the owner revoked that key for the address; only replace-key may trust it again.
 */
export type TrustOutcome = 'trusted' | 'already_trusted' | 'no_match' | 'conflict' | 'revoked';

const COLUMNS =
  'id, key_type, public_key_b64, fingerprint_sha256, status, first_seen_at, decided_by, decided_at';

/** The rows of one address: append `addressParams(address)` to the statement's parameters. */
const AT_ADDRESS = 'user_id = ? AND hostname = ? AND port = ?';

/** The stored form of an address (plan D-29): the hostname normalized, whoever built it. */
function stored<A extends HostKeyAddress>(address: A): A {
  return { ...address, hostname: normalizeHostname(address.hostname) };
}

function addressParams(address: HostKeyAddress): [string, string, number] {
  return [address.userId, address.hostname, address.port];
}

/**
 * Host-key trust store over `known_host_keys` (the daemon writes every row, plan §9). Rows are
 * keyed by address (D-29): the user, the normalized hostname and the port. A decision made
 * through one server applies to every server of that user with that address, never to another
 * user's, and outlives the servers: nothing here deletes rows of an address whose servers are
 * gone, so a revoked key stays revoked when a server is deleted and added again.
 *
 * Invariants: at most one `trusted` row per address and key type (also enforced by the partial
 * unique index; handled here so it never surfaces as a constraint error); pending rows expire
 * 24 h after `first_seen_at` (the only rows with a lifetime); a revoked fingerprint is never
 * recorded as pending nor trusted again except through replace-key; every pending/trust/replace/
 * revoke/mismatch (and a revoked key presented again) writes an `audit_events` row in the same
 * transaction, targeted at the server that triggered it, with the address in its detail.
 */
export class SqliteHostKeyStore implements HostKeyStore {
  readonly #sqlite: Sqlite;
  readonly #writer: BatchedWriter;
  readonly #now: () => number;

  constructor(db: TermavoxDb, writer: BatchedWriter, options: { now?: () => number } = {}) {
    this.#sqlite = db.$client;
    this.#writer = writer;
    this.#now = options.now ?? Date.now;
  }

  async trusted(address: HostKeyAddress): Promise<Map<string, PresentedHostKey>> {
    const rows = allRows<KeyRow>(
      this.#sqlite,
      `SELECT ${COLUMNS} FROM known_host_keys WHERE ${AT_ADDRESS} AND status = 'trusted'`,
      ...addressParams(stored(address)),
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

  /** Fingerprints of the address's revoked keys (decided against with the trusted ones). */
  async revoked(address: HostKeyAddress): Promise<Set<string>> {
    const rows = allRows<{ fingerprint_sha256: string }>(
      this.#sqlite,
      `SELECT DISTINCT fingerprint_sha256 FROM known_host_keys WHERE ${AT_ADDRESS} AND status = 'revoked'`,
      ...addressParams(stored(address)),
    );
    return new Set(rows.map((r) => r.fingerprint_sha256));
  }

  /**
   * Records a presented unknown key as pending (keeps `first_seen_at` of an existing one). A
   * revoked fingerprint is never recorded: it is not unknown, and no prompt may offer it.
   */
  recordPending(target: HostKeyTarget, key: PresentedHostKey): Promise<void> {
    const at = stored(target);
    return this.#writer.run('host_key.pending', (sqlite) => {
      const now = this.#now();
      if (this.#isRevoked(sqlite, at, key.fingerprint)) return;
      execute(
        sqlite,
        `DELETE FROM known_host_keys WHERE ${AT_ADDRESS} AND status = 'pending' AND first_seen_at <= ?`,
        ...addressParams(at),
        now - PENDING_TTL_MS,
      );
      const existing = getRow(
        sqlite,
        `SELECT id FROM known_host_keys
          WHERE ${AT_ADDRESS} AND status = 'pending' AND key_type = ? AND fingerprint_sha256 = ?`,
        ...addressParams(at),
        key.type,
        key.fingerprint,
      );
      if (existing) return;
      execute(
        sqlite,
        `INSERT INTO known_host_keys (id, user_id, hostname, port, key_type, public_key_b64,
           fingerprint_sha256, status, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        uuidv7(now),
        ...addressParams(at),
        key.type,
        key.publicKeyB64,
        key.fingerprint,
        now,
      );
      audit(
        sqlite,
        'host_key.pending',
        at,
        null,
        {
          keyType: key.type,
          fingerprint: key.fingerprint,
        },
        now,
      );
    });
  }

  /**
   * In-flow decision (`hostkey.decision`): trusts exactly the pending key, never a pasted one,
   * and never a revoked one. A key already trusted for the address counts as trusted: two of the
   * user's servers at one address may both wait on the same key, and the first accept promotes
   * the pending row the second one answers.
   */
  async trustPending(
    target: HostKeyTarget,
    fingerprint: string,
    decidedBy: string,
  ): Promise<boolean> {
    const outcome = await this.trust(target, { fingerprint, decidedBy, allowPreTrust: false });
    return outcome === 'trusted' || outcome === 'already_trusted';
  }

  /**
   * Fills `public_key_b64` of the trusted row of a pasted pre-trust fingerprint (NULL until the
   * key is first seen) once a presented key matched it (plan §9). No other row changes.
   */
  rememberPublicKey(address: HostKeyAddress, key: PresentedHostKey): Promise<void> {
    const at = stored(address);
    return this.#writer.run('host_key.public_key', (sqlite) => {
      execute(
        sqlite,
        `UPDATE known_host_keys SET public_key_b64 = ?
          WHERE ${AT_ADDRESS} AND key_type = ? AND fingerprint_sha256 = ? AND status = 'trusted'
            AND public_key_b64 IS NULL`,
        key.publicKeyB64,
        ...addressParams(at),
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
    target: HostKeyTarget,
    opts: { fingerprint: string; keyType?: string; decidedBy: string; allowPreTrust: boolean },
  ): Promise<TrustOutcome> {
    const at = stored(target);
    return this.#writer.run('host_key.trust', (sqlite): TrustOutcome => {
      const now = this.#now();
      const pending = this.#pending(sqlite, at, opts.fingerprint, opts.keyType, now);
      if (!pending) {
        // Trusted already (accepted through another session of the address, or pasted): nothing
        // new to trust, and no expired prompt either.
        if (this.#isTrusted(sqlite, at, opts.fingerprint, opts.keyType)) return 'already_trusted';
        if (!opts.allowPreTrust) return 'no_match';
      }
      const keyType = pending?.key_type ?? opts.keyType;
      if (!keyType) return 'no_match';
      const current = this.#trustedRow(sqlite, at, keyType);
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
      // A revoked key comes back only through replace-key (explicit and address-confirmed).
      if (this.#isRevoked(sqlite, at, opts.fingerprint)) return 'revoked';
      if (current) return 'conflict';
      this.#promote(sqlite, at, keyType, opts.fingerprint, pending, opts.decidedBy, now);
      audit(
        sqlite,
        'host_key.trust',
        at,
        opts.decidedBy,
        { keyType, fingerprint: opts.fingerprint, source: pending ? 'pending' : 'pasted' },
        now,
      );
      return 'trusted';
    });
  }

  /**
   * Internal API `replace-key` (after a mismatch): revokes the trusted key of that type and
   * trusts the given fingerprint (the pending key with it, if any, else as pasted).
   */
  replace(
    target: HostKeyTarget,
    keyType: string,
    fingerprint: string,
    decidedBy: string,
  ): Promise<void> {
    const at = stored(target);
    return this.#writer.run('host_key.replace', (sqlite) => {
      const now = this.#now();
      const current = this.#trustedRow(sqlite, at, keyType);
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
      const pending = this.#pending(sqlite, at, fingerprint, keyType, now);
      this.#promote(sqlite, at, keyType, fingerprint, pending, decidedBy, now);
      audit(
        sqlite,
        'host_key.replace',
        at,
        decidedBy,
        {
          keyType,
          previousFingerprint: current?.fingerprint_sha256 ?? null,
          fingerprint,
          source: pending ? 'pending' : 'pasted',
        },
        now,
      );
    });
  }

  /** Internal API `revoke-key`: false when no key of that type is trusted. */
  revoke(target: HostKeyTarget, keyType: string, decidedBy: string): Promise<boolean> {
    const at = stored(target);
    return this.#writer.run('host_key.revoke', (sqlite) => {
      const now = this.#now();
      const current = this.#trustedRow(sqlite, at, keyType);
      if (!current) return false;
      execute(
        sqlite,
        "UPDATE known_host_keys SET status = 'revoked', decided_by = ?, decided_at = ? WHERE id = ?",
        decidedBy,
        now,
        current.id,
      );
      audit(
        sqlite,
        'host_key.revoke',
        at,
        decidedBy,
        { keyType, fingerprint: current.fingerprint_sha256 },
        now,
      );
      return true;
    });
  }

  /**
   * Audits a host-key mismatch (a trusted key exists and the server presented another). The
   * actor is the user whose connection observed it.
   */
  recordMismatch(
    target: HostKeyTarget,
    presented: { type: string; fingerprint: string },
    actorUserId: string | null,
    detail: Record<string, unknown> = {},
  ): void {
    const at = stored(target);
    const now = this.#now();
    this.#writer.enqueue('host_key.mismatch', (sqlite) => {
      audit(
        sqlite,
        'host_key.mismatch',
        at,
        actorUserId,
        { keyType: presented.type, fingerprint: presented.fingerprint, ...detail },
        now,
      );
    });
  }

  /**
   * Audits a server presenting a key the owner revoked for the address (refused like a
   * mismatch). The actor is the user whose connection observed it.
   */
  recordRevokedPresented(
    target: HostKeyTarget,
    presented: { type: string; fingerprint: string },
    actorUserId: string | null,
    detail: Record<string, unknown> = {},
  ): void {
    const at = stored(target);
    const now = this.#now();
    this.#writer.enqueue('host_key.revoked_presented', (sqlite) => {
      audit(
        sqlite,
        'host_key.revoked_presented',
        at,
        actorUserId,
        { keyType: presented.type, fingerprint: presented.fingerprint, ...detail },
        now,
      );
    });
  }

  /** Every key row of an address (newest first), with pending expiry resolved. */
  async list(address: HostKeyAddress): Promise<HostKeyEntry[]> {
    const now = this.#now();
    return allRows<KeyRow>(
      this.#sqlite,
      `SELECT ${COLUMNS} FROM known_host_keys WHERE ${AT_ADDRESS} ORDER BY first_seen_at DESC, id DESC`,
      ...addressParams(stored(address)),
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
    at: HostKeyAddress,
    fingerprint: string,
    keyType: string | undefined,
    now: number,
  ): KeyRow | undefined {
    return getRow<KeyRow>(
      sqlite,
      `SELECT ${COLUMNS} FROM known_host_keys
        WHERE ${AT_ADDRESS} AND status = 'pending' AND fingerprint_sha256 = ?
          AND (? IS NULL OR key_type = ?) AND first_seen_at > ?
        ORDER BY first_seen_at DESC LIMIT 1`,
      ...addressParams(at),
      fingerprint,
      keyType ?? null,
      keyType ?? null,
      now - PENDING_TTL_MS,
    );
  }

  #isRevoked(sqlite: Sqlite, at: HostKeyAddress, fingerprint: string): boolean {
    return (
      getRow(
        sqlite,
        `SELECT 1 AS revoked FROM known_host_keys
          WHERE ${AT_ADDRESS} AND status = 'revoked' AND fingerprint_sha256 = ? LIMIT 1`,
        ...addressParams(at),
        fingerprint,
      ) !== undefined
    );
  }

  #isTrusted(
    sqlite: Sqlite,
    at: HostKeyAddress,
    fingerprint: string,
    keyType: string | undefined,
  ): boolean {
    return (
      getRow(
        sqlite,
        `SELECT 1 AS trusted FROM known_host_keys
          WHERE ${AT_ADDRESS} AND status = 'trusted' AND fingerprint_sha256 = ?
            AND (? IS NULL OR key_type = ?) LIMIT 1`,
        ...addressParams(at),
        fingerprint,
        keyType ?? null,
        keyType ?? null,
      ) !== undefined
    );
  }

  #trustedRow(sqlite: Sqlite, at: HostKeyAddress, keyType: string): KeyRow | undefined {
    return getRow<KeyRow>(
      sqlite,
      `SELECT ${COLUMNS} FROM known_host_keys WHERE ${AT_ADDRESS} AND key_type = ? AND status = 'trusted'`,
      ...addressParams(at),
      keyType,
    );
  }

  /** Makes `pending` (or a new pasted row) the trusted key; drops other pending rows of that type. */
  #promote(
    sqlite: Sqlite,
    at: HostKeyAddress,
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
        `INSERT INTO known_host_keys (id, user_id, hostname, port, key_type, public_key_b64,
           fingerprint_sha256, status, first_seen_at, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'trusted', ?, ?, ?)`,
        uuidv7(now),
        ...addressParams(at),
        keyType,
        fingerprint,
        now,
        decidedBy,
        now,
      );
    }
    execute(
      sqlite,
      `DELETE FROM known_host_keys WHERE ${AT_ADDRESS} AND key_type = ? AND status = 'pending'`,
      ...addressParams(at),
      keyType,
    );
  }
}

/**
 * One `host_key.*` audit row (inside the change's transaction): targeted at the server that
 * triggered it (null once gone), with the address the decision applies to in its detail.
 */
function audit(
  sqlite: Sqlite,
  type: Extract<DaemonAuditType, `host_key.${string}`>,
  at: HostKeyTarget,
  actorUserId: string | null,
  detail: Record<string, unknown>,
  now: number,
): void {
  insertAudit(sqlite, {
    type,
    actorUserId,
    targetType: 'server',
    targetId: at.serverId,
    detail: { ...detail, hostname: at.hostname, port: at.port },
    at: now,
  });
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
          const target = sessionHostKeyTarget(record);
          if (decision === 'mismatch') {
            hostKeys.recordMismatch(target, key, record.userId, { sessionId: record.id });
          }
          if (decision === 'revoked') {
            hostKeys.recordRevokedPresented(target, key, record.userId, { sessionId: record.id });
          }
          hooks.onHostKey(key, decision);
        },
        onKeyboardInteractive: (request) => hooks.onKeyboardInteractive(request),
      });
    },
  };
}
