import type { TermdockDb } from '@termdock/db';
import type { CreateCredentialRequest } from '@termdock/protocol';
import { ErrorCode, TermdockError, uuidv7 } from '@termdock/shared';
import ssh2 from 'ssh2';
import type { z } from 'zod';
import type { CredentialProvider, CredentialSecret } from '../core/types.ts';
import { requireActingUser } from '../store/access.ts';
import { insertAudit } from '../store/audit.ts';
import type { BatchedWriter } from '../store/batched-writer.ts';
import { execute, getRow, type Sqlite } from '../store/sqlite.ts';
import { fingerprintOf } from '../transport/ssh/host-key.ts';
import type { CredentialKind, Vault } from './vault.ts';

export type CreateCredentialInput = z.infer<typeof CreateCredentialRequest>;

export interface CreatedCredential {
  credentialId: string;
  /** OpenSSH public key line for key credentials, null for passwords. */
  publicKey: string | null;
  /** `SHA256:<base64>` of the public key, null for passwords. */
  fingerprint: string | null;
}

const GENERATED_KEY_COMMENT = 'termdock';

/**
 * Validates an OpenSSH/PEM/PPK private key with ssh2's parser (incl. its passphrase) and
 * returns its public half. Error messages are generic: they never echo key material.
 */
export function inspectPrivateKey(
  privateKey: string,
  passphrase?: string,
): { publicKey: string; fingerprint: string } {
  const parsed = ssh2.utils.parseKey(privateKey, passphrase) as
    | ReturnType<typeof ssh2.utils.parseKey>
    | ReturnType<typeof ssh2.utils.parseKey>[];
  if (parsed instanceof Error) {
    throw new TermdockError(
      ErrorCode.BadRequest,
      /passphrase|decrypt/i.test(parsed.message)
        ? 'wrong or missing passphrase for the private key'
        : 'unsupported or malformed private key',
    );
  }
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  const key = keys[0];
  if (keys.length !== 1 || !key || key instanceof Error) {
    throw new TermdockError(ErrorCode.BadRequest, 'expected exactly one private key');
  }
  if (!key.isPrivateKey()) throw new TermdockError(ErrorCode.BadRequest, 'not a private key');
  const blob = key.getPublicSSH();
  const comment = key.comment?.trim();
  return {
    publicKey: `${key.type} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`,
    fingerprint: fingerprintOf(blob),
  };
}

export interface CredentialServiceOptions {
  db: TermdockDb;
  writer: BatchedWriter;
  vault: Vault;
  now?: () => number;
}

/**
 * Credential management for the internal API (plan §8.3). The daemon writes every
 * `credentials` row; secrets are sealed by the vault before they reach the writer and are
 * never logged or returned.
 */
export class CredentialService {
  readonly #writer: BatchedWriter;
  readonly #vault: Vault;
  readonly #now: () => number;

  constructor(options: CredentialServiceOptions) {
    this.#writer = options.writer;
    this.#vault = options.vault;
    this.#now = options.now ?? Date.now;
  }

  async create(input: CreateCredentialInput): Promise<CreatedCredential> {
    const now = this.#now();
    const credentialId = uuidv7(now);
    let secret: CredentialSecret;
    let publicKey: string | null = null;
    let fingerprint: string | null = null;
    switch (input.kind) {
      case 'password':
        secret = { kind: 'password', password: input.password };
        break;
      case 'private_key': {
        const passphrase = input.passphrase ? input.passphrase : undefined;
        ({ publicKey, fingerprint } = inspectPrivateKey(input.privateKey, passphrase));
        secret = {
          kind: 'private_key',
          privateKey: input.privateKey,
          ...(passphrase !== undefined ? { passphrase } : {}),
        };
        break;
      }
      case 'generate': {
        const pair = ssh2.utils.generateKeyPairSync('ed25519', { comment: GENERATED_KEY_COMMENT });
        ({ publicKey, fingerprint } = inspectPrivateKey(pair.private));
        secret = { kind: 'private_key', privateKey: pair.private };
        break;
      }
    }
    const kind: CredentialKind = secret.kind;
    const sealed = this.#vault.seal({ credentialId, userId: input.actingUserId, kind }, secret);
    await this.#writer.run('credential.create', (sqlite) => {
      requireActingUser(sqlite, input.actingUserId, now);
      execute(
        sqlite,
        `INSERT INTO credentials (id, user_id, name, kind, public_key, fingerprint_sha256, ciphertext,
           nonce, key_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        credentialId,
        input.actingUserId,
        input.name,
        kind,
        publicKey,
        fingerprint,
        sealed.ciphertext,
        sealed.nonce,
        sealed.keyVersion,
        now,
      );
      insertAudit(sqlite, {
        type: 'credential.create',
        actorUserId: input.actingUserId,
        targetType: 'credential',
        targetId: credentialId,
        detail: { name: input.name, kind: input.kind, fingerprint },
        at: now,
      });
    });
    return { credentialId, publicKey, fingerprint };
  }

  /** Renames a credential of the acting user (the only mutable field); 404 otherwise. */
  rename(actingUserId: string, credentialId: string, name: string): Promise<void> {
    return this.#writer.run('credential.rename', (sqlite) => {
      const now = this.#now();
      requireActingUser(sqlite, actingUserId, now);
      const changed = execute(
        sqlite,
        'UPDATE credentials SET name = ? WHERE id = ? AND user_id = ?',
        name,
        credentialId,
        actingUserId,
      );
      if (changed === 0) throw new TermdockError(ErrorCode.NotFound, 'credential not found');
      insertAudit(sqlite, {
        type: 'credential.rename',
        actorUserId: actingUserId,
        targetType: 'credential',
        targetId: credentialId,
        detail: { name },
        at: now,
      });
    });
  }

  /** Deletes a credential of the acting user; 409 while a non-ended session references it. */
  delete(actingUserId: string, credentialId: string): Promise<void> {
    return this.#writer.run('credential.delete', (sqlite) => {
      const now = this.#now();
      requireActingUser(sqlite, actingUserId, now);
      const row = getRow<{ name: string }>(
        sqlite,
        'SELECT name FROM credentials WHERE id = ? AND user_id = ?',
        credentialId,
        actingUserId,
      );
      if (!row) throw new TermdockError(ErrorCode.NotFound, 'credential not found');
      const inUse = getRow(
        sqlite,
        "SELECT 1 FROM sessions WHERE target_credential_id = ? AND state <> 'ended' LIMIT 1",
        credentialId,
      );
      if (inUse) {
        throw new TermdockError(
          ErrorCode.Conflict,
          'credential is used by a session that has not ended',
        );
      }
      execute(sqlite, 'DELETE FROM credentials WHERE id = ?', credentialId);
      insertAudit(sqlite, {
        type: 'credential.delete',
        actorUserId: actingUserId,
        targetType: 'credential',
        targetId: credentialId,
        detail: { name: row.name },
        at: now,
      });
    });
  }
}

/**
 * `CredentialProvider` over the vault. Every failure (missing or foreign credential, failed
 * authentication, malformed envelope, DB error) is a `TermdockError(CREDENTIAL_INVALID)`: the
 * runtime parks the session on it instead of retrying forever. Updates `last_used_at` through
 * the batched writer.
 */
export class VaultCredentialProvider implements CredentialProvider {
  readonly #sqlite: Sqlite;
  readonly #writer: BatchedWriter;
  readonly #vault: Vault;
  readonly #now: () => number;

  constructor(options: CredentialServiceOptions) {
    this.#sqlite = options.db.$client;
    this.#writer = options.writer;
    this.#vault = options.vault;
    this.#now = options.now ?? Date.now;
  }

  async get(credentialId: string, userId: string): Promise<CredentialSecret> {
    let secret: CredentialSecret;
    try {
      const row = getRow<{
        user_id: string;
        kind: string;
        ciphertext: Buffer;
        nonce: Buffer;
        key_version: number;
      }>(
        this.#sqlite,
        'SELECT user_id, kind, ciphertext, nonce, key_version FROM credentials WHERE id = ?',
        credentialId,
      );
      if (!row || row.user_id !== userId) {
        throw new TermdockError(ErrorCode.CredentialInvalid, 'credential not found');
      }
      if (row.kind !== 'password' && row.kind !== 'private_key') {
        throw new TermdockError(ErrorCode.CredentialInvalid, 'credential kind is invalid');
      }
      secret = this.#vault.open(
        { credentialId, userId, kind: row.kind },
        { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version },
      );
    } catch (err) {
      if (err instanceof TermdockError) throw err;
      // No cause attached: nothing from the failure path is worth risking in a log line.
      throw new TermdockError(ErrorCode.CredentialInvalid, 'credential cannot be decrypted');
    }
    const at = this.#now();
    this.#writer.enqueue('credential.last_used_at', (sqlite) => {
      execute(sqlite, 'UPDATE credentials SET last_used_at = ? WHERE id = ?', at, credentialId);
    });
    return secret;
  }
}
