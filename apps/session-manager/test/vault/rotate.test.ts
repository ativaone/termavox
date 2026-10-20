import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createSecretKey, type KeyObject, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, runVaultRotate } from '../../src/cli/vault-rotate.ts';
import type { CredentialSecret } from '../../src/core/types.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import { DataDirLockedError, lockDataDir } from '../../src/store/data-dir-lock.ts';
import type { Sqlite } from '../../src/store/sqlite.ts';
import { CredentialService, VaultCredentialProvider } from '../../src/vault/credentials.ts';
import { RotateError, rotateVault } from '../../src/vault/rotate.ts';
import {
  ensureVaultKeyCheck,
  KeyCheckMismatchError,
  openVault,
  parseKeyCheck,
  Vault,
} from '../../src/vault/vault.ts';
import { insertUser, type TempDb, tempDb } from '../store/fixture.ts';

const KEYS = new URL('../../../../test/sshd/keys/', import.meta.url);
const TEST_KEY_PASSPHRASE = readFileSync(new URL('id_ed25519_passphrase', KEYS), 'utf8');
const PASSPHRASE = 'termavox-test-passphrase';
const CLI = fileURLToPath(new URL('../../src/cli/vault-rotate.ts', import.meta.url));
const LOCK_MODULE = new URL('../../src/store/data-dir-lock.ts', import.meta.url).href;
const FIXED_NOW = () => new Date('2026-10-16T12:15:00.123Z');

interface Key {
  encoded: string;
  object: KeyObject;
  file: string;
}

/** Every table's rows (BLOBs as hex), in rowid order: equal snapshots mean equal content. */
function snapshot(sqlite: Sqlite): string {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return JSON.stringify(
    tables.map(({ name }) => [
      name,
      sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
    (_key, value) => (Buffer.isBuffer(value) ? `hex:${value.toString('hex')}` : value),
  );
}

function backups(dir: string): string[] {
  return readdirSync(dir).filter((name) => /^pre-rotate-.*\.db$/.test(name));
}

interface CredentialRow {
  id: string;
  user_id: string;
  kind: 'password' | 'private_key';
  ciphertext: Buffer;
  nonce: Buffer;
  key_version: number;
}

describe('vault rotate', () => {
  let fixture: TempDb;
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    fixture?.cleanup();
  });

  function key(name: string): Key {
    const raw = randomBytes(32);
    const encoded = raw.toString('base64');
    const object = createSecretKey(raw);
    raw.fill(0);
    const file = join(fixture.dir, name);
    writeFileSync(file, `${encoded}\n`, { mode: 0o600 });
    return { encoded, object, file };
  }

  /** A database with a key check under `old` (version 1) and three credentials of two kinds. */
  async function setup() {
    fixture = tempDb();
    const secrets: Record<string, CredentialSecret> = {};
    const { db } = fixture;
    const old = key('master_key');
    const next = key('master_key.new');
    const writer = new BatchedWriter(db);
    const vault = new Vault(new Map([[1, old.object]]), 1);
    expect(await ensureVaultKeyCheck(writer, vault)).toBe('created');
    const service = new CredentialService({ db, writer, vault });
    const owner = insertUser(db);
    const other = insertUser(db);
    const pw = await service.create({
      actingUserId: owner,
      kind: 'password',
      name: 'pw',
      password: 'hunter2-sécret',
    });
    secrets[pw.credentialId] = { kind: 'password', password: 'hunter2-sécret' };
    const imported = await service.create({
      actingUserId: owner,
      kind: 'private_key',
      name: 'imported',
      privateKey: TEST_KEY_PASSPHRASE,
      passphrase: PASSPHRASE,
    });
    secrets[imported.credentialId] = {
      kind: 'private_key',
      privateKey: TEST_KEY_PASSPHRASE,
      passphrase: PASSPHRASE,
    };
    const second = await service.create({
      actingUserId: other,
      kind: 'password',
      name: 'other',
      password: 'correct horse',
    });
    secrets[second.credentialId] = { kind: 'password', password: 'correct horse' };
    await writer.close();
    const sqlite = db.$client;
    const rows = () =>
      sqlite
        .prepare(
          'SELECT id, user_id, kind, ciphertext, nonce, key_version FROM credentials ORDER BY id',
        )
        .all() as CredentialRow[];
    const keyCheck = () =>
      parseKeyCheck(
        JSON.parse(
          (
            sqlite
              .prepare("SELECT value_json FROM instance_settings WHERE key = 'vault_key_check'")
              .get() as { value_json: string }
          ).value_json,
        ),
      );
    return { db, sqlite, old, next, owner, secrets, rows, keyCheck, dbFile: fixture.file };
  }

  const options = (old: Key, next: Key, extra: { dryRun?: boolean } = {}) => ({
    dataDir: fixture.dir,
    oldKey: old.object,
    newKey: next.object,
    now: FIXED_NOW,
    ...extra,
  });

  function expectRefused(run: () => unknown, reason: RotateError['reason']): RotateError {
    let caught: unknown;
    try {
      run();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RotateError);
    expect((caught as RotateError).reason).toBe(reason);
    return caught as RotateError;
  }

  it('dry run: decrypts every row with the old key, reports the counts and writes nothing', async () => {
    const { sqlite, old, next } = await setup();
    const before = snapshot(sqlite);
    const result = rotateVault(options(old, next, { dryRun: true }));
    expect(result).toMatchObject({
      dryRun: true,
      fromVersion: 1,
      toVersion: 2,
      credentials: 3,
      byKind: { password: 2, private_key: 1 },
      backupFile: null,
    });
    expect(snapshot(sqlite)).toBe(before);
    expect(backups(fixture.dir)).toEqual([]);
  });

  it('rotates every row and the key check to version 2; only the new key opens them', async () => {
    const { db, sqlite, old, next, secrets, rows, keyCheck } = await setup();
    const before = rows();
    const result = rotateVault(options(old, next));
    expect(result).toMatchObject({
      dryRun: false,
      fromVersion: 1,
      toVersion: 2,
      credentials: 3,
      byKind: { password: 2, private_key: 1 },
    });

    const after = rows();
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    const newVault = new Vault(new Map([[2, next.object]]), 2);
    // The old key under the new version: authentication fails (AAD and key both differ).
    const oldAtV2 = new Vault(new Map([[2, old.object]]), 2);
    for (const [i, row] of after.entries()) {
      expect(row.key_version).toBe(2);
      expect(row.nonce.equals(before[i]!.nonce)).toBe(false); // a fresh nonce per row
      const binding = { credentialId: row.id, userId: row.user_id, kind: row.kind };
      const sealed = { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version };
      expect(newVault.open(binding, sealed)).toEqual(secrets[row.id]);
      expect(() => oldAtV2.open(binding, sealed)).toThrow(/authentication/);
    }
    // The key check moved to the new key and version.
    expect(keyCheck().keyVersion).toBe(2);
    expect(() => newVault.verifyKeyCheck(keyCheck())).not.toThrow();
    expect(() => oldAtV2.verifyKeyCheck(keyCheck())).toThrow(KeyCheckMismatchError);
    // The daemon's boot path: the old key file is refused, the new one opens at version 2.
    const writer = new BatchedWriter(db);
    await expect(openVault(writer, old.file)).rejects.toThrow(KeyCheckMismatchError);
    const opened = await openVault(writer, next.file);
    expect(opened).toMatchObject({ keyCheck: 'verified' });
    expect(opened.vault.currentVersion).toBe(2);
    await writer.close();

    // The backup: next to the database, mode 0600, the pre-rotation state (old key, version 1).
    expect(result.backupFile).toBe(join(fixture.dir, 'pre-rotate-20261016T121500Z.db'));
    expect(backups(fixture.dir)).toEqual(['pre-rotate-20261016T121500Z.db']);
    expect(statSync(result.backupFile!).mode & 0o777).toBe(0o600);
    sqlite.prepare('ATTACH DATABASE ? AS copy').run(result.backupFile);
    try {
      const copied = sqlite
        .prepare('SELECT id, ciphertext, key_version FROM copy.credentials ORDER BY id')
        .all() as CredentialRow[];
      expect(copied.map((r) => [r.id, r.key_version, r.ciphertext.toString('hex')])).toEqual(
        before.map((r) => [r.id, 1, r.ciphertext.toString('hex')]),
      );
    } finally {
      sqlite.exec('DETACH DATABASE copy');
    }

    // Running it again with the same keys: already done, nothing changes.
    const rotated = snapshot(sqlite);
    expectRefused(() => rotateVault(options(old, next)), 'already-rotated');
    expect(snapshot(sqlite)).toBe(rotated);
  });

  it('refuses a wrong old key before anything else', async () => {
    const { sqlite, next } = await setup();
    const wrong = key('wrong_key');
    const before = snapshot(sqlite);
    const err = expectRefused(() => rotateVault(options(wrong, next)), 'wrong-old-key');
    expect(err.message).toMatch(/old key does not match this database/);
    expect(err.backupFile).toBeNull();
    expect(snapshot(sqlite)).toBe(before);
    expect(backups(fixture.dir)).toEqual([]);
  });

  it('refuses equal old and new keys', async () => {
    const { sqlite, old } = await setup();
    const same = { ...old, object: createSecretKey(Buffer.from(old.encoded, 'base64')) };
    const before = snapshot(sqlite);
    expectRefused(() => rotateVault(options(old, same)), 'equal-keys');
    expect(snapshot(sqlite)).toBe(before);
    expect(backups(fixture.dir)).toEqual([]);
  });

  it('rolls the whole transaction back when one row does not authenticate', async () => {
    const { sqlite, old, next, rows } = await setup();
    // Corrupt the last row in rotation order: the rows before it are re-encrypted first.
    const victim = rows().at(-1)!;
    const corrupted = Buffer.from(victim.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0x01;
    sqlite.prepare('UPDATE credentials SET ciphertext = ? WHERE id = ?').run(corrupted, victim.id);
    const before = snapshot(sqlite);

    const err = expectRefused(() => rotateVault(options(old, next)), 'credential-invalid');
    expect(err.message).toContain(victim.id);
    expect(err.message).toMatch(/1 of 3 credentials do not decrypt with the old key/);
    // Byte-for-byte the same content: the re-encrypted rows and the key check rolled back.
    expect(snapshot(sqlite)).toBe(before);
    // The backup was taken before the transaction and is kept (it holds the unchanged data).
    expect(err.backupFile).toBe(join(fixture.dir, 'pre-rotate-20261016T121500Z.db'));
    expect(backups(fixture.dir)).toHaveLength(1);

    // The dry run reports the same row and writes nothing.
    expectRefused(() => rotateVault(options(old, next, { dryRun: true })), 'credential-invalid');
    expect(snapshot(sqlite)).toBe(before);
  });

  it('refuses while the data directory lock is held, in this process or another', async () => {
    const { sqlite, old, next, dbFile } = await setup();
    const before = snapshot(sqlite);

    // The daemon's own lock call, in this process.
    const held = lockDataDir(dbFile);
    expectRefused(() => rotateVault(options(old, next)), 'locked');
    expectRefused(() => rotateVault(options(old, next, { dryRun: true })), 'locked');
    held.release();

    // Another process holds it (as a running session-manager does); its death frees the lock.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { lockDataDir } from ${JSON.stringify(LOCK_MODULE)};
         lockDataDir(process.argv[1]);
         process.stdout.write('locked\\n');
         setInterval(() => {}, 1 << 30);`,
        dbFile,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve();
      });
      child.on('exit', (code) => reject(new Error(`lock holder exited early (${code})`)));
    });
    const err = expectRefused(() => rotateVault(options(old, next)), 'locked');
    expect(err.message).toMatch(/in use by a running session-manager/);
    expect(snapshot(sqlite)).toBe(before);
    expect(backups(fixture.dir)).toEqual([]);

    child.kill('SIGKILL'); // no cleanup runs: the kernel drops the lock with the process
    await new Promise((resolve) => child.once('exit', resolve));
    expect(rotateVault(options(old, next)).credentials).toBe(3);
  });

  it('the daemon refuses to boot while vault rotate holds the lock', async () => {
    const { dbFile } = await setup();
    const held = lockDataDir(dbFile);
    try {
      const { startDaemon } = await import('../../src/main.ts');
      // The lock is the first boot step: nothing else of the config is read before it.
      const config = { dbFile, dataDir: fixture.dir, logLevel: 'silent' };
      await expect(startDaemon(config as Parameters<typeof startDaemon>[0])).rejects.toBeInstanceOf(
        DataDirLockedError,
      );
    } finally {
      held.release();
    }
  });

  it('a vault opened with the new key after rotation seals new credentials at the new version', async () => {
    const { db, old, next, owner, secrets } = await setup();
    rotateVault(options(old, next));
    const writer = new BatchedWriter(db);
    const { vault } = await openVault(writer, next.file);
    const service = new CredentialService({ db, writer, vault });
    const provider = new VaultCredentialProvider({ db, writer, vault });
    const created = await service.create({
      actingUserId: owner,
      kind: 'password',
      name: 'after rotation',
      password: 'fresh-secret',
    });
    const row = db.$client
      .prepare('SELECT key_version FROM credentials WHERE id = ?')
      .get(created.credentialId) as { key_version: number };
    expect(row.key_version).toBe(2);
    expect(await provider.get(created.credentialId, owner)).toEqual({
      kind: 'password',
      password: 'fresh-secret',
    });
    // The rotated ones open through the same provider.
    for (const [id, secret] of Object.entries(secrets)) {
      const userId = (
        db.$client.prepare('SELECT user_id FROM credentials WHERE id = ?').get(id) as {
          user_id: string;
        }
      ).user_id;
      expect(await provider.get(id, userId)).toEqual(secret);
    }
    await writer.close();
  });

  describe('command line', () => {
    function io() {
      const out: string[] = [];
      const err: string[] = [];
      return {
        out,
        err,
        io: {
          env: {},
          cwd: fixture.dir,
          out: (line: string) => out.push(line),
          err: (line: string) => err.push(line),
        },
      };
    }

    it('reports the rotation and the next steps, never key material', async () => {
      const { old, next } = await setup();
      const dry = io();
      const args = ['--old-key-file', 'master_key', '--new-key-file', 'master_key.new'];
      expect(await runVaultRotate([...args, '--data-dir', '.', '--dry-run'], dry.io)).toBe(EXIT.ok);
      expect(dry.out.join('\n')).toMatch(
        /dry run: 3 credentials \(2 passwords, 1 private key\) decrypt with the old key/,
      );
      expect(dry.out.join('\n')).toContain('nothing was written');

      const real = io();
      expect(await runVaultRotate([...args, '--data-dir', fixture.dir], real.io)).toBe(EXIT.ok);
      const printed = real.out.join('\n');
      expect(printed).toContain(`backup: ${join(fixture.dir, 'pre-rotate-')}`);
      expect(printed).toMatch(/rotated: 3 credentials .* re-encrypted under key version 2/);
      expect(printed).toContain('Next steps:');
      for (const output of [dry.out, dry.err, real.out, real.err]) {
        expect(output.join('\n')).not.toContain(old.encoded);
        expect(output.join('\n')).not.toContain(next.encoded);
      }

      const again = io();
      expect(await runVaultRotate([...args, '--data-dir', fixture.dir], again.io)).toBe(
        EXIT.alreadyRotated,
      );
      expect(again.err.join('\n')).toMatch(/already uses the new key/);
    });

    it('exits non-zero on bad arguments, a wrong old key and a corrupted row', async () => {
      const { sqlite, rows } = await setup();
      const usage = io();
      expect(await runVaultRotate(['--old-key-file', 'master_key'], usage.io)).toBe(EXIT.usage);
      expect(usage.err.join('\n')).toMatch(/--new-key-file are required/);
      expect(await runVaultRotate(['--bogus'], io().io)).toBe(EXIT.usage);
      const missing = io();
      expect(
        await runVaultRotate(
          ['--old-key-file', 'nope', '--new-key-file', 'master_key.new', '--data-dir', '.'],
          missing.io,
        ),
      ).toBe(EXIT.usage);
      expect(missing.err.join('\n')).toMatch(/cannot read --old-key-file .*nope \(ENOENT\)/);
      const same = io();
      expect(
        await runVaultRotate(
          ['--old-key-file', 'master_key', '--new-key-file', 'master_key', '--data-dir', '.'],
          same.io,
        ),
      ).toBe(EXIT.usage);
      expect(same.err.join('\n')).toMatch(/old and new keys are the same/);

      key('wrong_key');
      const wrong = io();
      expect(
        await runVaultRotate(
          ['--old-key-file', 'wrong_key', '--new-key-file', 'master_key.new', '--data-dir', '.'],
          wrong.io,
        ),
      ).toBe(EXIT.failed);
      expect(wrong.err.join('\n')).toMatch(/old key does not match this database/);
      expect(wrong.err.join('\n')).toContain('nothing was changed');

      const victim = rows()[0]!;
      sqlite
        .prepare('UPDATE credentials SET nonce = ? WHERE id = ?')
        .run(randomBytes(12), victim.id);
      const bad = io();
      expect(
        await runVaultRotate(
          ['--old-key-file', 'master_key', '--new-key-file', 'master_key.new', '--data-dir', '.'],
          bad.io,
        ),
      ).toBe(EXIT.credentialInvalid);
      expect(bad.err.join('\n')).toMatch(/is a copy of the unchanged database/);
    });

    it('runs as a script (node src/cli/vault-rotate.ts), as in the container', async () => {
      await setup();
      const run = spawnSync(
        process.execPath,
        [
          CLI,
          '--old-key-file',
          join(fixture.dir, 'master_key'),
          '--new-key-file',
          join(fixture.dir, 'master_key.new'),
          '--dry-run',
        ],
        { env: { ...process.env, TERMAVOX_DATA_DIR: fixture.dir }, encoding: 'utf8' },
      );
      expect(run.stderr).toBe('');
      expect(run.status).toBe(EXIT.ok);
      expect(run.stdout).toMatch(/^vault rotate \(dry run\): .*app\.db$/m);
    });
  });
});
