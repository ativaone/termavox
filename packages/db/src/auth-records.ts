import type { TermavoxDb } from './client.ts';

type Sqlite = TermavoxDb['$client'];

/**
 * TOTP reset: removes the user's TOTP secret and backup codes, clears `two_factor_enabled` and
 * forgets every trusted device, in one transaction (a savepoint inside the caller's). Returns
 * false if the user does not exist. Shared by web's admin TOTP reset and session-manager's
 * `reset-password --reset-totp` (plan D-36).
 */
export function resetTotp(sqlite: Sqlite, userId: string, now: number = Date.now()): boolean {
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
