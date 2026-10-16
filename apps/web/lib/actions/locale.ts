'use server';

import { cookies, headers } from 'next/headers';
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_S } from '../../i18n/locales.ts';
import { authGate } from '../auth/gate.ts';
import { getAuthRuntime } from '../auth/server.ts';
import { SESSION_COOKIE } from '../auth-cookies.ts';
import { setUserLocale } from '../repo/users.ts';

/**
 * The locale switcher: always writes the `NEXT_LOCALE` cookie and, when signed in (including a
 * user held on a forced password change or enrollment), the account's `user.locale`. Setting a
 * cookie in a Server Action re-renders the current route in the new language.
 */
export async function setLocale(formData: FormData): Promise<void> {
  const locale = formData.get('locale');
  if (!isLocale(locale)) return;
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE_S,
    sameSite: 'lax',
    secure: true,
    httpOnly: true,
  });
  if (!cookieStore.has(SESSION_COOKIE)) return;
  const runtime = getAuthRuntime();
  const gate = await authGate(runtime, await headers(), {
    allow: ['password-change', 'totp-enrollment'],
  });
  if (gate.ok) setUserLocale(runtime.db, gate.user.id, locale);
}
