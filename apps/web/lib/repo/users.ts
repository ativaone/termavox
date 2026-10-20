import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';
import type { Locale } from '../../i18n/locales.ts';

/**
 * Writes the user's UI language. `user.locale` is declared `input: false` in Better Auth (users
 * cannot set it through `/update-user`), and web owns the auth tables (plan §9), so the locale
 * switcher writes it here, scoped to the signed-in user's own row.
 */
export function setUserLocale(
  db: TermavoxDb,
  userId: string,
  locale: Locale,
  now: number = Date.now(),
): void {
  db.$client
    .prepare('UPDATE user SET locale = ?, updated_at = ? WHERE id = ? AND locale <> ?')
    .run(locale, now, userId, locale);
}
