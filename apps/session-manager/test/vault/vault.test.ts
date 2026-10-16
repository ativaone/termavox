import { createSecretKey, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialSecret } from '../../src/core/types.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import { parsePublicKeyLine } from '../../src/transport/ssh/host-key.ts';
import {
  CredentialService,
  GENERATE_KEY_ATTEMPTS,
  generateEd25519Key,
  VaultCredentialProvider,
} from '../../src/vault/credentials.ts';
import { parseMasterKey, VaultError } from '../../src/vault/master-key.ts';
import {
  type CredentialBinding,
  ensureVaultKeyCheck,
  TAG_BYTES,
  Vault,
} from '../../src/vault/vault.ts';
import { insertUser, type TempDb, tempDb, testVault } from '../store/fixture.ts';

const KEYS = new URL('../../../../test/sshd/keys/', import.meta.url);
const TEST_KEY = readFileSync(new URL('id_ed25519', KEYS), 'utf8');
const TEST_KEY_PASSPHRASE = readFileSync(new URL('id_ed25519_passphrase', KEYS), 'utf8');
const PASSPHRASE = 'termdock-test-passphrase';
const TEST_KEY_FINGERPRINT = 'SHA256:l0QRLCAtKH6Gb16KKefB+gzm47fuHwPGrLltuW+6G94';

const binding: CredentialBinding = { credentialId: 'cred-1', userId: 'user-1', kind: 'password' };
const password: CredentialSecret = { kind: 'password', password: 's3cret-pässword' };

function expectCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toSatisfy(
    (err: unknown) => err instanceof TermdockError && err.code === code,
  );
}

describe('master key', () => {
  it('accepts exactly 32 base64 bytes and rejects anything else', () => {
    const encoded = randomBytes(32).toString('base64');
    expect(parseMasterKey(`${encoded}\n`).symmetricKeySize).toBe(32);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(/16 bytes/);
    expect(() => parseMasterKey(randomBytes(33).toString('base64'))).toThrow(/33 bytes/);
    expect(() => parseMasterKey('not base64 at all!')).toThrow(VaultError);
    expect(() => parseMasterKey('')).toThrow(VaultError);
  });
});

describe('Vault', () => {
  it('round-trips the envelope of each kind', () => {
    const vault = testVault();
    const sealed = vault.seal(binding, password);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext.includes(Buffer.from('s3cret'))).toBe(false);
    expect(vault.open(binding, sealed)).toEqual(password);

    const keyBinding = { ...binding, kind: 'private_key' as const };
    const key: CredentialSecret = {
      kind: 'private_key',
      privateKey: TEST_KEY_PASSPHRASE,
      passphrase: PASSPHRASE,
    };
    expect(vault.open(keyBinding, vault.seal(keyBinding, key))).toEqual(key);
    const bare: CredentialSecret = { kind: 'private_key', privateKey: TEST_KEY };
    expect(vault.open(keyBinding, vault.seal(keyBinding, bare))).toEqual(bare);
    // A fresh nonce per record.
    expect(vault.seal(binding, password).nonce.equals(sealed.nonce)).toBe(false);
  });

  it('binds the ciphertext to credential id, user, kind and key version (AAD)', () => {
    const raw = randomBytes(32);
    // Same key bytes under versions 1 and 2: only the AAD differs between them.
    const vault = new Vault(
      new Map([
        [1, createSecretKey(raw)],
        [2, createSecretKey(raw)],
      ]),
      1,
    );
    raw.fill(0); // KeyObjects hold their own copy
    const sealed = vault.seal(binding, password);
    expect(vault.open(binding, sealed)).toEqual(password);
    expect(() => vault.open({ ...binding, credentialId: 'cred-2' }, sealed)).toThrow(VaultError);
    expect(() => vault.open({ ...binding, userId: 'user-2' }, sealed)).toThrow(VaultError);
    expect(() => vault.open({ ...binding, kind: 'private_key' }, sealed)).toThrow(VaultError);
    expect(() => vault.open(binding, { ...sealed, keyVersion: 2 })).toThrow(VaultError);
    expect(() => vault.open(binding, { ...sealed, keyVersion: 3 })).toThrow(
      /unknown vault key version/,
    );
  });

  it('rejects tampered ciphertext, tag and nonce', () => {
    const vault = testVault();
    const sealed = vault.seal(binding, password);
    const flip = (buf: Buffer, at: number): Buffer => {
      const copy = Buffer.from(buf);
      copy[at] = copy[at]! ^ 0x01;
      return copy;
    };
    expect(() =>
      vault.open(binding, { ...sealed, ciphertext: flip(sealed.ciphertext, 0) }),
    ).toThrow(/authentication/);
    const tagAt = sealed.ciphertext.length - TAG_BYTES;
    expect(() =>
      vault.open(binding, { ...sealed, ciphertext: flip(sealed.ciphertext, tagAt) }),
    ).toThrow(/authentication/);
    expect(() => vault.open(binding, { ...sealed, nonce: flip(sealed.nonce, 3) })).toThrow(
      /authentication/,
    );
    expect(() =>
      vault.open(binding, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 8) }),
    ).toThrow(VaultError);
  });

  it('detects a wrong KEK with the key check', () => {
    const vault = testVault();
    const check = vault.createKeyCheck();
    expect(() => vault.verifyKeyCheck(check)).not.toThrow();
    expect(() => testVault().verifyKeyCheck(check)).toThrow(/does not match this database/);
    expect(() => vault.verifyKeyCheck({ ...check, v: 2 })).toThrow(/malformed/);
  });
});

describe('generated keys', () => {
  // ssh2's generator emits a malformed OpenSSH key about once in 400 calls.
  const malformed = TEST_KEY.replace(/^(-----BEGIN[^\n]*\n)[^\n]{8}/, '$1AAAAAAAA');

  it('keeps only a key that parses back', () => {
    const outputs = [malformed, malformed, TEST_KEY];
    const key = generateEd25519Key(() => ({ private: outputs.shift()! }));
    expect(key.privateKey).toBe(TEST_KEY);
    expect(key.fingerprint).toBe(TEST_KEY_FINGERPRINT);
    expect(outputs).toHaveLength(0);
  });

  it('gives up after a bounded number of attempts', () => {
    let calls = 0;
    expect(() =>
      generateEd25519Key(() => {
        calls++;
        return { private: malformed };
      }),
    ).toThrow(TermdockError);
    expect(calls).toBe(GENERATE_KEY_ATTEMPTS);
  });

  it('generates parseable ed25519 keys', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateEd25519Key().publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* termdock$/);
    }
  });
});

describe('vault on SQLite', () => {
  let fixture: TempDb;
  afterEach(() => fixture?.cleanup());

  function setup(vault = testVault()) {
    fixture = tempDb();
    const { db } = fixture;
    const writer = new BatchedWriter(db);
    return {
      db,
      writer,
      vault,
      service: new CredentialService({ db, writer, vault }),
      provider: new VaultCredentialProvider({ db, writer, vault }),
    };
  }

  it('creates the key check on first boot, verifies it later and fails fast on a wrong KEK', async () => {
    const { db, writer, vault, service } = setup();
    expect(await ensureVaultKeyCheck(writer, vault)).toBe('created');
    expect(await ensureVaultKeyCheck(writer, vault)).toBe('verified');
    await expect(ensureVaultKeyCheck(writer, testVault())).rejects.toThrow(/does not match/);

    // A missing key check while credentials exist is refused (the KEK cannot be verified).
    const userId = insertUser(db);
    await service.create({ actingUserId: userId, kind: 'password', name: 'p', password: 'x' });
    db.$client.prepare("DELETE FROM instance_settings WHERE key = 'vault_key_check'").run();
    await expect(ensureVaultKeyCheck(writer, vault)).rejects.toThrow(
      /missing but credentials exist/,
    );
  });

  it('stores password, imported and generated keys sealed; the provider decrypts only for the owner', async () => {
    const { db, writer, service, provider } = setup();
    const owner = insertUser(db);
    const other = insertUser(db);

    const pw = await service.create({
      actingUserId: owner,
      kind: 'password',
      name: 'pw',
      password: 'hunter2-secret',
    });
    expect(pw).toMatchObject({ publicKey: null, fingerprint: null });
    expect(await provider.get(pw.credentialId, owner)).toEqual({
      kind: 'password',
      password: 'hunter2-secret',
    });

    const imported = await service.create({
      actingUserId: owner,
      kind: 'private_key',
      name: 'imported',
      privateKey: TEST_KEY_PASSPHRASE,
      passphrase: PASSPHRASE,
    });
    expect(await provider.get(imported.credentialId, owner)).toEqual({
      kind: 'private_key',
      privateKey: TEST_KEY_PASSPHRASE,
      passphrase: PASSPHRASE,
    });
    const plain = await service.create({
      actingUserId: owner,
      kind: 'private_key',
      name: 'k',
      privateKey: TEST_KEY,
    });
    expect(plain.fingerprint).toBe(TEST_KEY_FINGERPRINT);
    expect(parsePublicKeyLine(plain.publicKey!).fingerprint).toBe(TEST_KEY_FINGERPRINT);

    const generated = await service.create({
      actingUserId: owner,
      kind: 'generate',
      name: 'gen',
      algorithm: 'ed25519',
    });
    expect(generated.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* termdock$/);
    expect(parsePublicKeyLine(generated.publicKey!).fingerprint).toBe(generated.fingerprint);
    const secret = await provider.get(generated.credentialId, owner);
    expect(secret.kind === 'private_key' && secret.privateKey).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----/,
    );

    // Bad key material is a 400, never echoed.
    await expectCode(
      service.create({
        actingUserId: owner,
        kind: 'private_key',
        name: 'x',
        privateKey: TEST_KEY_PASSPHRASE,
        passphrase: 'nope',
      }),
      ErrorCode.BadRequest,
    );
    await expectCode(
      service.create({
        actingUserId: owner,
        kind: 'private_key',
        name: 'x',
        privateKey: 'garbage',
      }),
      ErrorCode.BadRequest,
    );

    // Foreign, missing and moved ciphertexts are CREDENTIAL_INVALID (the runtime parks on it).
    await expectCode(provider.get(pw.credentialId, other), ErrorCode.CredentialInvalid);
    await expectCode(provider.get('missing', owner), ErrorCode.CredentialInvalid);
    const sqlite = db.$client;
    const second = await service.create({
      actingUserId: owner,
      kind: 'password',
      name: 'pw2',
      password: 'other',
    });
    sqlite
      .prepare(
        'UPDATE credentials SET ciphertext = (SELECT ciphertext FROM credentials WHERE id = ?), nonce = (SELECT nonce FROM credentials WHERE id = ?) WHERE id = ?',
      )
      .run(pw.credentialId, pw.credentialId, second.credentialId);
    await expectCode(provider.get(second.credentialId, owner), ErrorCode.CredentialInvalid);

    // No plaintext secret anywhere in the table; last_used_at goes through the writer.
    await writer.flush();
    const dump = JSON.stringify(sqlite.prepare('SELECT * FROM credentials').all(), (_k, v) =>
      Buffer.isBuffer(v) ? v.toString('latin1') : v,
    );
    for (const needle of ['hunter2-secret', PASSPHRASE, 'OPENSSH PRIVATE KEY']) {
      expect(dump.includes(needle)).toBe(false);
    }
    const used = sqlite
      .prepare('SELECT last_used_at FROM credentials WHERE id = ?')
      .get(pw.credentialId) as {
      last_used_at: number | null;
    };
    expect(used.last_used_at).toBeGreaterThan(0);
  });
});
