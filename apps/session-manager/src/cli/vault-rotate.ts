/**
 * `vault rotate` (plan §10.2): re-encrypts every stored credential under a new master key.
 *
 *   node src/cli/vault-rotate.ts --old-key-file <file> --new-key-file <file>
 *        [--data-dir <dir>] [--dry-run]
 *
 * Run it while session-manager is stopped (it refuses otherwise), then start session-manager
 * with the new key file. deploy/scripts/rotate-master-key.sh does the whole sequence for a
 * Compose install. The logic lives in src/vault/rotate.ts; this file parses the command line and
 * reports. Output never contains key material.
 */
import type { KeyObject } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadMasterKey, VaultError } from '../vault/master-key.ts';
import { RotateError, type RotateResult, rotateVault } from '../vault/rotate.ts';

/** Exit statuses (deploy/scripts/rotate-master-key.sh relies on 0, 3 and 4). */
export const EXIT = {
  ok: 0,
  /** Refused or failed; the database is unchanged. */
  failed: 1,
  /** Bad command line or key files; nothing was opened. */
  usage: 2,
  /** The database already uses the new key: the rotation happened before. */
  alreadyRotated: 3,
  /** The old key matches the key check, but a credential does not decrypt with it. */
  credentialInvalid: 4,
  /** An unexpected error: check the database's state with --dry-run before anything else. */
  unexpected: 70,
} as const;

export const USAGE = `Usage: node src/cli/vault-rotate.ts --old-key-file <file> --new-key-file <file> [options]

Re-encrypts every stored credential and the vault key check under a new master key, in one
transaction, after writing a backup next to the database (pre-rotate-<timestamp>.db). Stop
session-manager first; start it with the new key file afterwards.

  --old-key-file <file>  the current master key (the file TERMAVOX_MASTER_KEY_FILE names)
  --new-key-file <file>  the new master key: 32 random bytes, base64 (openssl rand -base64 32)
  --data-dir <dir>       the directory holding app.db (default: $TERMAVOX_DATA_DIR, else /data)
  --dry-run              check that every credential decrypts with the old key; write nothing
  -h, --help             show this help

Exit status: 0 done, 1 refused or failed (nothing changed), 2 bad arguments, 3 the database
already uses the new key, 4 a credential does not decrypt with the old key (nothing changed),
70 unexpected error (run again with --dry-run to see which key the database uses).`;

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out(line: string): void;
  err(line: string): void;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function kinds(result: RotateResult): string {
  const parts: string[] = [];
  if (result.byKind.password > 0) parts.push(plural(result.byKind.password, 'password'));
  if (result.byKind.private_key > 0) parts.push(plural(result.byKind.private_key, 'private key'));
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Runs the command; resolves with the exit status. */
export async function runVaultRotate(argv: string[], io: CliIo): Promise<number> {
  let values: {
    'old-key-file'?: string;
    'new-key-file'?: string;
    'data-dir'?: string;
    'dry-run'?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'old-key-file': { type: 'string' },
        'new-key-file': { type: 'string' },
        'data-dir': { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.err(`vault rotate: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  if (values.help) {
    io.out(USAGE);
    return EXIT.ok;
  }
  const oldKeyFile = values['old-key-file'];
  const newKeyFile = values['new-key-file'];
  if (!oldKeyFile || !newKeyFile) {
    io.err('vault rotate: --old-key-file and --new-key-file are required');
    io.err(USAGE);
    return EXIT.usage;
  }
  // Relative paths are the caller's: pnpm runs package scripts from the package directory and
  // passes the directory it was started from as INIT_CWD.
  const base = io.env.INIT_CWD || io.cwd;
  const path = (p: string): string => (isAbsolute(p) ? p : resolve(base, p));
  const dataDir = path(values['data-dir'] ?? io.env.TERMAVOX_DATA_DIR ?? '/data');
  const dryRun = values['dry-run'] ?? false;

  let oldKey: KeyObject;
  let newKey: KeyObject;
  try {
    oldKey = await loadMasterKey(path(oldKeyFile), '--old-key-file');
    newKey = await loadMasterKey(path(newKeyFile), '--new-key-file');
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    io.err(`vault rotate: ${err.message}`);
    return EXIT.usage;
  }

  let result: RotateResult;
  try {
    result = rotateVault({ dataDir, oldKey, newKey, dryRun });
  } catch (err) {
    if (err instanceof RotateError) {
      io.err(`vault rotate: ${err.message}`);
      if (err.reason === 'already-rotated') return EXIT.alreadyRotated;
      if (!err.backupFile) io.err('nothing was changed');
      else if (err.reason === 'backup-failed') {
        io.err(`nothing was changed; delete the incomplete backup ${err.backupFile}`);
      } else {
        io.err(
          `nothing was changed; the backup ${err.backupFile} is a copy of the unchanged ` +
            'database and can be deleted',
        );
      }
      if (err.reason === 'equal-keys') return EXIT.usage;
      return err.reason === 'credential-invalid' ? EXIT.credentialInvalid : EXIT.failed;
    }
    if (err instanceof VaultError) {
      io.err(`vault rotate: ${err.message}`);
      io.err('nothing was changed');
      return EXIT.failed;
    }
    throw err;
  }

  const count = plural(result.credentials, 'credential');
  if (result.dryRun) {
    io.out(`vault rotate (dry run): ${result.dbFile}`);
    io.out(`old key: verified (key version ${result.fromVersion})`);
    io.out(
      `dry run: ${count}${kinds(result)} decrypt with the old key and would move to key version ${result.toVersion}`,
    );
    io.out('nothing was written');
    return EXIT.ok;
  }
  io.out(`vault rotate: ${result.dbFile}`);
  io.out(`old key: verified (key version ${result.fromVersion})`);
  io.out(`backup: ${result.backupFile}`);
  io.out(`rotated: ${count}${kinds(result)} re-encrypted under key version ${result.toVersion}`);
  io.out('');
  io.out('Next steps:');
  io.out('  1. Replace the master key file (TERMAVOX_MASTER_KEY_FILE) with the new key and start');
  io.out('     session-manager: it verifies the new key at boot.');
  io.out('  2. Keep the old key until session-manager runs with the new key and a session');
  io.out('     connects: the backup above opens only with the old key.');
  io.out('  3. Then delete the old key file and the backup.');
  return EXIT.ok;
}

if (import.meta.main) {
  process.exitCode = await runVaultRotate(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).catch((err: unknown) => {
    // The message only: never a dump of objects that might hold secrets.
    process.stderr.write(`vault rotate: unexpected error: ${(err as Error)?.message ?? err}\n`);
    process.stderr.write('run again with --dry-run to see which key the database uses\n');
    return EXIT.unexpected;
  });
}
