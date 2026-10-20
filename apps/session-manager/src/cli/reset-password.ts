/**
 * `reset-password` (plan D-36): a new temporary password for a user when no admin can reset it
 * from the admin pages, typically because the only admin forgot theirs.
 *
 *   node src/cli/reset-password.ts [--reset-totp] [--data-dir <dir>] <username>
 *
 * It does what an admin's reset does (apps/web/lib/auth/account.ts, setTemporaryPassword): a
 * generated temporary password, a forced change at the next sign-in, every sign-in of the user
 * ended and their open WebSockets closed (through the internal API, best effort), and an
 * `auth.password_reset` audit row, here without an actor. `--reset-totp` also does what an
 * admin's TOTP reset does (resetTotp in @termavox/db, audited as `auth.totp_reset`), for a user
 * who lost their authenticator and their backup codes too. It runs next to the running stack:
 * deploy/scripts/reset-password.sh runs it in the session-manager container. The temporary
 * password is printed once, on stdout, and nowhere else.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb, resetTotp } from '@termavox/db';
import { INTERNAL_API_PREFIX } from '@termavox/protocol';
import { hashPassword, randomToken } from '@termavox/shared';
import { readSecretFile } from '../config/config.ts';
import { insertAudit } from '../store/audit.ts';
import { allRows, execute, getRow, type Sqlite } from '../store/sqlite.ts';

export const EXIT = {
  ok: 0,
  /** Refused or failed (no database, no such user); nothing changed. */
  failed: 1,
  /** Bad command line; nothing was opened. */
  usage: 2,
  unexpected: 70,
} as const;

export const USAGE = `Usage: node src/cli/reset-password.ts [options] <username>

Sets a new temporary password for a user and prints it. The user signs in with it and must then
choose a new password. Every sign-in of the user ends and their open terminals disconnect; their
sessions keep running. Meant for when no admin can sign in: otherwise an admin resets passwords
on the user's admin page.

  --reset-totp      also remove the user's TOTP (authenticator, backup codes, trusted devices),
                    for a lost authenticator; they set it up again when it is required
  --data-dir <dir>  the directory holding app.db (default: $TERMAVOX_DATA_DIR, else /data)
  -h, --help        show this help

Exit status: 0 done, 1 refused or failed (nothing changed), 2 bad arguments, 70 unexpected error.`;

/** 20 characters of [a-z2-7] (100 bits): easy to copy and to type, used only once. */
const TEMPORARY_PASSWORD_LENGTH = 20;
/** Users listed when the username is unknown. */
const MAX_LISTED_USERS = 50;
const CLOSE_TIMEOUT_MS = 5000;

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out(line: string): void;
  err(line: string): void;
}

export interface ResetPasswordDeps {
  /** Closes the user's open WebSockets; resolves false when the daemon could not be told. */
  closeConnections(userId: string): Promise<boolean>;
  /** The temporary password (tests pass a fixed one). */
  generatePassword(): string;
}

export class ResetPasswordError extends Error {}

export interface ResetResult {
  userId: string;
  username: string;
  role: string;
  disabled: boolean;
  signInsEnded: number;
  /** TOTP was on before the reset. */
  totpEnabled: boolean;
  totpReset: boolean;
  /** TOTP is mandatory for the user (their own flag or the instance setting). */
  totpRequired: boolean;
}

interface UserRow {
  id: string;
  username: string;
  role: string;
  banned: number;
  ban_expires: number | null;
  two_factor_enabled: number;
  totp_required: number;
}

/** Instance-wide TOTP requirement, read like web does (`instance_settings` key `require_totp`). */
function totpRequiredInstanceWide(sqlite: Sqlite): boolean {
  const row = getRow<{ value_json: string }>(
    sqlite,
    'SELECT value_json FROM instance_settings WHERE key = ?',
    'require_totp',
  );
  if (!row) return false;
  try {
    return JSON.parse(row.value_json) === true;
  } catch {
    return false;
  }
}

/**
 * Stores the new hash and, in the same transaction, forces a change at the next sign-in, ends
 * every sign-in of the user and writes the audit row. Usernames are stored lowercase (Better
 * Auth's username plugin normalizes them).
 */
export function resetPassword(
  sqlite: Sqlite,
  input: { username: string; passwordHash: string; resetTotp?: boolean; now?: number },
): ResetResult {
  const now = input.now ?? Date.now();
  const username = input.username.trim().toLowerCase();
  return sqlite
    .transaction((): ResetResult => {
      const user = getRow<UserRow>(
        sqlite,
        `SELECT id, username, role, banned, ban_expires, two_factor_enabled, totp_required
         FROM user WHERE username = ?`,
        username,
      );
      if (!user) {
        const known = allRows<{ username: string | null; role: string }>(
          sqlite,
          `SELECT username, role FROM user ORDER BY username LIMIT ${MAX_LISTED_USERS + 1}`,
        );
        const names = known
          .slice(0, MAX_LISTED_USERS)
          .map((u) => `${u.username ?? '(no username)'} (${u.role})`);
        if (known.length > MAX_LISTED_USERS) names.push('…');
        throw new ResetPasswordError(
          `no user named "${username}"; users: ${names.length > 0 ? names.join(', ') : 'none'}`,
        );
      }
      const changed = execute(
        sqlite,
        "UPDATE account SET password = ?, updated_at = ? WHERE user_id = ? AND provider_id = 'credential'",
        input.passwordHash,
        now,
        user.id,
      );
      if (changed === 0) {
        throw new ResetPasswordError(`user "${username}" has no password sign-in to reset`);
      }
      execute(
        sqlite,
        'UPDATE user SET must_change_password = 1, updated_at = ? WHERE id = ?',
        now,
        user.id,
      );
      const signInsEnded = execute(sqlite, 'DELETE FROM auth_session WHERE user_id = ?', user.id);
      insertAudit(sqlite, {
        type: 'auth.password_reset',
        actorUserId: null,
        targetType: 'user',
        targetId: user.id,
        detail: { via: 'operator', signInsEnded },
        at: now,
      });
      if (input.resetTotp) {
        resetTotp(sqlite, user.id, now);
        insertAudit(sqlite, {
          type: 'auth.totp_reset',
          actorUserId: null,
          targetType: 'user',
          targetId: user.id,
          detail: { via: 'operator' },
          at: now,
        });
      }
      return {
        userId: user.id,
        username: user.username,
        role: user.role,
        disabled: user.banned === 1 && (user.ban_expires === null || user.ban_expires > now),
        signInsEnded,
        totpEnabled: user.two_factor_enabled === 1,
        totpReset: input.resetTotp === true,
        totpRequired: user.totp_required === 1 || totpRequiredInstanceWide(sqlite),
      };
    })
    .immediate();
}

/** Asks the running daemon to close the user's WebSockets (`POST /auth-sessions/revoke`). */
export async function closeConnectionsViaInternalApi(
  env: NodeJS.ProcessEnv,
  userId: string,
): Promise<boolean> {
  const tokenFile = env.TERMAVOX_INTERNAL_TOKEN_FILE;
  if (!tokenFile) return false;
  try {
    const token = new TextDecoder().decode(await readSecretFile(tokenFile));
    const host = env.TERMAVOX_INTERNAL_HOST || '127.0.0.1';
    const port = env.TERMAVOX_INTERNAL_PORT || '3002';
    const res = await fetch(`http://${host}:${port}${INTERNAL_API_PREFIX}/auth-sessions/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function totpResetMessage(result: ResetResult): string {
  if (result.totpRequired) {
    return result.totpEnabled
      ? 'TOTP was reset: after the new password, they set up their authenticator again (TOTP ' +
          'is required for them).'
      : 'TOTP was not on: after the new password, they set up their authenticator (TOTP is ' +
          'required for them).';
  }
  return result.totpEnabled
    ? 'TOTP was reset: two-factor sign-in is off until they turn it on again in their account ' +
        'settings.'
    : 'TOTP was not on for this user: nothing to reset.';
}

/** Runs the command; resolves with the exit status. */
export async function runResetPassword(
  argv: string[],
  io: CliIo,
  deps: Partial<ResetPasswordDeps> = {},
): Promise<number> {
  let values: { 'reset-totp'?: boolean; 'data-dir'?: string; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        'reset-totp': { type: 'boolean' },
        'data-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    io.err(`reset-password: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  if (values.help) {
    io.out(USAGE);
    return EXIT.ok;
  }
  if (positionals.length !== 1 || !positionals[0]?.trim()) {
    io.err('reset-password: exactly one username is required');
    io.err(USAGE);
    return EXIT.usage;
  }
  const base = io.env.INIT_CWD || io.cwd;
  const rawDir = values['data-dir'] ?? io.env.TERMAVOX_DATA_DIR ?? '/data';
  const dbFile = join(isAbsolute(rawDir) ? rawDir : resolve(base, rawDir), 'app.db');
  // openDb would create an empty database at a mistyped path.
  if (!existsSync(dbFile)) {
    io.err(`reset-password: no database at ${dbFile}`);
    return EXIT.failed;
  }

  const password = (deps.generatePassword ?? (() => randomToken(TEMPORARY_PASSWORD_LENGTH)))();
  const passwordHash = await hashPassword(password);
  const db = openDb(dbFile);
  let result: ResetResult;
  try {
    result = resetPassword(db.$client, {
      username: positionals[0],
      passwordHash,
      resetTotp: values['reset-totp'] === true,
    });
  } catch (err) {
    if (!(err instanceof ResetPasswordError)) throw err;
    io.err(`reset-password: ${err.message}`);
    io.err('nothing was changed');
    return EXIT.failed;
  } finally {
    db.$client.close();
  }

  const close = deps.closeConnections ?? ((id) => closeConnectionsViaInternalApi(io.env, id));
  const closed = await close(result.userId);
  io.out(`reset-password: ${result.username} (${result.role})`);
  io.out(`temporary password: ${password}`);
  io.out('');
  io.out('Sign in with it: Termavox then asks for a new password.');
  io.out(
    `${result.signInsEnded} sign-in${result.signInsEnded === 1 ? '' : 's'} ended; ` +
      (closed
        ? 'open terminals were disconnected (their sessions keep running).'
        : 'open terminals could not be disconnected (session-manager did not answer); they ' +
          'close when session-manager restarts.'),
  );
  if (result.totpReset) {
    io.out(totpResetMessage(result));
  } else if (result.totpEnabled) {
    io.out(
      'TOTP stays on: sign-in still asks for a code or a backup code. If the authenticator is ' +
        'lost too, run this again with --reset-totp.',
    );
  }
  if (result.disabled) {
    io.out('This account is disabled: an admin must enable it before it can sign in.');
  }
  io.out(
    'If sign-in says it is locked after earlier failed attempts, wait up to 15 minutes or ' +
      'restart web.',
  );
  return EXIT.ok;
}

if (import.meta.main) {
  process.exitCode = await runResetPassword(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).catch((err: unknown) => {
    process.stderr.write(`reset-password: unexpected error: ${(err as Error)?.message ?? err}\n`);
    return EXIT.unexpected;
  });
}
