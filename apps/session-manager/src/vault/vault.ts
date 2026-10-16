import { createCipheriv, createDecipheriv, type KeyObject, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { CredentialSecret } from '../core/types.ts';
import type { BatchedWriter } from '../store/batched-writer.ts';
import { insertSettingIfAbsent, readSetting, SETTING_VAULT_KEY_CHECK } from '../store/settings.ts';
import { getRow } from '../store/sqlite.ts';
import { loadMasterKey, VaultError } from './master-key.ts';

/**
 * Credential vault (plan §10.2): envelope encryption of credential secrets under the KEK.
 *
 * - AES-256-GCM, a fresh 96-bit random nonce per record, 128-bit tag.
 * - Plaintext: the JSON envelope `{ v: 1, kind, password? | privateKey?, passphrase? }`.
 * - Storage: `credentials.nonce` = the 12-byte nonce; `credentials.ciphertext` = GCM ciphertext
 *   followed by the 16-byte tag; `credentials.key_version` = the KEK version used.
 * - AAD (binds the ciphertext to its row): `lp("termdock.credential.v1") ‖ lp(credential_id) ‖
 *   lp(user_id) ‖ lp(kind) ‖ u32be(key_version)`, where `lp(s)` = u32be(byte length of the UTF-8
 *   string) followed by those bytes. Moving a ciphertext to another row, user, kind or key
 *   version makes authentication fail.
 * - Key check (`instance_settings.vault_key_check`): GCM encryption of a constant under the KEK
 *   with its own AAD (`lp("termdock.vault-key-check.v1") ‖ u32be(key_version)`), created on the
 *   first boot and verified on every boot, so a wrong KEK fails fast instead of failing every
 *   connect later.
 *
 * Decrypted plaintext buffers are zeroed after use; the strings handed to ssh2 cannot be.
 */
export type CredentialKind = CredentialSecret['kind'];

export interface CredentialBinding {
  credentialId: string;
  userId: string;
  kind: CredentialKind;
}

export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

const ALGORITHM = 'aes-256-gcm';
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
const CREDENTIAL_AAD_DOMAIN = 'termdock.credential.v1';
const KEY_CHECK_AAD_DOMAIN = 'termdock.vault-key-check.v1';
const KEY_CHECK_PLAINTEXT = 'termdock vault key check v1';

const Envelope = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), kind: z.literal('password'), password: z.string() }).strict(),
  z
    .object({
      v: z.literal(1),
      kind: z.literal('private_key'),
      privateKey: z.string(),
      passphrase: z.string().optional(),
    })
    .strict(),
]);

const KeyCheck = z.object({
  v: z.literal(1),
  alg: z.literal(ALGORITHM),
  keyVersion: z.number().int().min(1),
  nonce: z.base64(),
  ciphertext: z.base64(),
});
export type KeyCheck = z.infer<typeof KeyCheck>;

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

/** The AAD of a credential record (see the module comment for the encoding). */
export function credentialAad(binding: CredentialBinding, keyVersion: number): Buffer {
  return Buffer.concat([
    lengthPrefixed(CREDENTIAL_AAD_DOMAIN),
    lengthPrefixed(binding.credentialId),
    lengthPrefixed(binding.userId),
    lengthPrefixed(binding.kind),
    u32(keyVersion),
  ]);
}

function keyCheckAad(keyVersion: number): Buffer {
  return Buffer.concat([lengthPrefixed(KEY_CHECK_AAD_DOMAIN), u32(keyVersion)]);
}

export class Vault {
  readonly #keys: ReadonlyMap<number, KeyObject>;
  readonly currentVersion: number;

  constructor(keys: ReadonlyMap<number, KeyObject>, currentVersion = 1) {
    const current = keys.get(currentVersion);
    if (current?.type !== 'secret' || current.symmetricKeySize !== 32) {
      throw new VaultError(`vault key version ${currentVersion} is missing or not 32 bytes`);
    }
    this.#keys = keys;
    this.currentVersion = currentVersion;
  }

  /** The vault over the KEK file (key version 1; rotation arrives in Phase 8). */
  static async fromFile(path: string): Promise<Vault> {
    return new Vault(new Map([[1, await loadMasterKey(path)]]), 1);
  }

  seal(binding: CredentialBinding, secret: CredentialSecret): SealedSecret {
    if (secret.kind !== binding.kind) throw new VaultError('secret kind does not match');
    const envelope =
      secret.kind === 'password'
        ? { v: 1, kind: secret.kind, password: secret.password }
        : {
            v: 1,
            kind: secret.kind,
            privateKey: secret.privateKey,
            ...(secret.passphrase !== undefined ? { passphrase: secret.passphrase } : {}),
          };
    const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8');
    try {
      const keyVersion = this.currentVersion;
      return {
        ...this.#encrypt(keyVersion, plaintext, credentialAad(binding, keyVersion)),
        keyVersion,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  /** Throws VaultError when the record does not authenticate for this binding. */
  open(binding: CredentialBinding, sealed: SealedSecret): CredentialSecret {
    const plaintext = this.#decrypt(
      sealed.keyVersion,
      sealed.nonce,
      sealed.ciphertext,
      credentialAad(binding, sealed.keyVersion),
    );
    try {
      let json: unknown;
      try {
        json = JSON.parse(plaintext.toString('utf8'));
      } catch {
        // JSON.parse messages quote the input: never let them out.
        throw new VaultError('credential envelope is not valid JSON');
      }
      const parsed = Envelope.safeParse(json);
      if (!parsed.success || parsed.data.kind !== binding.kind) {
        throw new VaultError('credential envelope is invalid');
      }
      const data = parsed.data;
      return data.kind === 'password'
        ? { kind: 'password', password: data.password }
        : {
            kind: 'private_key',
            privateKey: data.privateKey,
            ...(data.passphrase !== undefined ? { passphrase: data.passphrase } : {}),
          };
    } finally {
      plaintext.fill(0);
    }
  }

  createKeyCheck(): KeyCheck {
    const keyVersion = this.currentVersion;
    const { nonce, ciphertext } = this.#encrypt(
      keyVersion,
      Buffer.from(KEY_CHECK_PLAINTEXT, 'utf8'),
      keyCheckAad(keyVersion),
    );
    return {
      v: 1,
      alg: ALGORITHM,
      keyVersion,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  /** Throws a VaultError with an operator-facing message when the KEK does not match. */
  verifyKeyCheck(value: unknown): void {
    const parsed = KeyCheck.safeParse(value);
    if (!parsed.success) throw new VaultError('instance_settings.vault_key_check is malformed');
    const check = parsed.data;
    if (!this.#keys.has(check.keyVersion)) {
      throw new VaultError(
        `vault_key_check uses key version ${check.keyVersion}, which is not loaded`,
      );
    }
    let plaintext: Buffer;
    try {
      plaintext = this.#decrypt(
        check.keyVersion,
        Buffer.from(check.nonce, 'base64'),
        Buffer.from(check.ciphertext, 'base64'),
        keyCheckAad(check.keyVersion),
      );
    } catch {
      throw new VaultError(
        'TERMDOCK_MASTER_KEY_FILE does not match this database (vault_key_check failed): ' +
          'wrong master key, or the database belongs to another installation',
      );
    }
    if (plaintext.toString('utf8') !== KEY_CHECK_PLAINTEXT) {
      throw new VaultError('vault_key_check decrypted to an unexpected value');
    }
  }

  #encrypt(
    keyVersion: number,
    plaintext: Buffer,
    aad: Buffer,
  ): { nonce: Buffer; ciphertext: Buffer } {
    const key = this.#key(keyVersion);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { nonce, ciphertext };
  }

  #decrypt(keyVersion: number, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
    const key = this.#key(keyVersion);
    if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) {
      throw new VaultError('sealed record is malformed');
    }
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    // update() yields plaintext before the tag is checked: wipe it if final() rejects.
    const head = decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES));
    let tail: Buffer;
    try {
      tail = decipher.final();
    } catch {
      head.fill(0);
      throw new VaultError('sealed record failed authentication');
    }
    const plaintext = Buffer.concat([head, tail]);
    head.fill(0);
    tail.fill(0);
    return plaintext;
  }

  #key(keyVersion: number): KeyObject {
    const key = this.#keys.get(keyVersion);
    if (!key) throw new VaultError(`unknown vault key version ${keyVersion}`);
    return key;
  }
}

/**
 * Boot step 2 (plan §5.8): verifies the KEK against `vault_key_check`, creating the check on the
 * first boot. A missing check while credentials exist is refused: the KEK cannot be validated.
 */
export function ensureVaultKeyCheck(
  writer: BatchedWriter,
  vault: Vault,
): Promise<'created' | 'verified'> {
  return writer.run('vault_key_check', (sqlite) => {
    const existing = readSetting(sqlite, SETTING_VAULT_KEY_CHECK);
    if (existing !== undefined) {
      vault.verifyKeyCheck(existing);
      return 'verified';
    }
    const credentials = getRow<{ n: number }>(sqlite, 'SELECT COUNT(*) AS n FROM credentials');
    if ((credentials?.n ?? 0) > 0) {
      throw new VaultError(
        'instance_settings.vault_key_check is missing but credentials exist; ' +
          'refusing to start because the master key cannot be verified',
      );
    }
    insertSettingIfAbsent(sqlite, SETTING_VAULT_KEY_CHECK, vault.createKeyCheck());
    return 'created';
  });
}
