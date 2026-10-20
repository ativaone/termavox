import '../server-guard.ts';
import { resetTotp as resetTotpRecords, type TermavoxDb } from '@termavox/db';

/**
 * Small direct reads and writes the auth core needs outside Better Auth. Raw SQL on the shared
 * better-sqlite3 handle, as session-manager does (drizzle-orm is not a direct web dependency).
 */

export function hasAnyUser(db: TermavoxDb): boolean {
  return db.$client.prepare('SELECT 1 FROM user LIMIT 1').get() !== undefined;
}

/** Instance-wide TOTP requirement: `instance_settings` key `require_totp`, `value_json` true/false. */
export function isTotpRequiredInstanceWide(db: TermavoxDb): boolean {
  const row = db.$client
    .prepare('SELECT value_json FROM instance_settings WHERE key = ?')
    .get('require_totp') as { value_json: string } | undefined;
  if (!row) return false;
  try {
    return JSON.parse(row.value_json) === true;
  } catch {
    return false;
  }
}

/**
 * Admin TOTP reset: removes the user's TOTP secret and backup codes, clears `two_factor_enabled`
 * and forgets every trusted device, in one transaction. Returns false if the user does not exist.
 */
export function resetTotp(db: TermavoxDb, userId: string, now: number = Date.now()): boolean {
  return resetTotpRecords(db.$client, userId, now);
}
