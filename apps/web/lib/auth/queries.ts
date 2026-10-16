import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';

/**
 * Small direct reads and writes the auth core needs outside Better Auth. Raw SQL on the shared
 * better-sqlite3 handle, as session-manager does (drizzle-orm is not a direct web dependency).
 */

export function hasAnyUser(db: TermdockDb): boolean {
  return db.$client.prepare('SELECT 1 FROM user LIMIT 1').get() !== undefined;
}

/** Instance-wide TOTP requirement: `instance_settings` key `require_totp`, `value_json` true/false. */
export function isTotpRequiredInstanceWide(db: TermdockDb): boolean {
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
export function resetTotp(db: TermdockDb, userId: string, now: number = Date.now()): boolean {
  const sqlite = db.$client;
  return sqlite.transaction(() => {
    const updated = sqlite
      .prepare('UPDATE user SET two_factor_enabled = 0, updated_at = ? WHERE id = ?')
      .run(now, userId);
    if (updated.changes === 0) return false;
    sqlite.prepare('DELETE FROM two_factor WHERE user_id = ?').run(userId);
    // Trusted-device records are Better Auth verification rows `trust-device-*` valued with the user id.
    sqlite
      .prepare("DELETE FROM verification WHERE value = ? AND identifier LIKE 'trust-device-%'")
      .run(userId);
    return true;
  })();
}
