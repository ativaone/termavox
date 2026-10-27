'use server';

import { cookies, headers } from 'next/headers';
import { authGate } from '../auth/gate.ts';
import { getAuthRuntime } from '../auth/server.ts';
import { SESSION_COOKIE } from '../auth-cookies.ts';
import { isTheme, THEME_COOKIE, THEME_COOKIE_MAX_AGE_S } from '../preferences/theme.ts';
import { saveTheme } from '../repo/preferences.ts';

/**
 * The theme choice (plan D-55), from the account menu's dialog or the account settings page:
 * writes this browser's cookie and, when signed in (including a user held on a forced password
 * change or enrollment), the account's `user_preferences.theme`. Setting a cookie in a Server
 * Action re-renders the route, root layout included, in the new theme.
 */
export async function setTheme(formData: FormData): Promise<void> {
  const theme = formData.get('theme');
  if (!isTheme(theme)) return;
  const cookieStore = await cookies();
  cookieStore.set(THEME_COOKIE, theme, {
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE_S,
    sameSite: 'lax',
    secure: true,
    httpOnly: true,
  });
  if (!cookieStore.has(SESSION_COOKIE)) return;
  const runtime = getAuthRuntime();
  const gate = await authGate(runtime, await headers(), {
    allow: ['password-change', 'totp-enrollment'],
  });
  if (gate.ok) saveTheme(runtime.db, gate.user.id, theme);
}
