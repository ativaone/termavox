import '../server-guard.ts';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { requestUser } from '../auth/request-user.ts';
import { getAuthRuntime } from '../auth/server.ts';
import { getTheme } from '../repo/preferences.ts';
import { resolveTheme, THEME_COOKIE, type Theme } from './theme.ts';

/**
 * The theme this request renders in (plan D-55): the signed-in user's stored choice, else this
 * browser's cookie, else System. Read by the root layout for `<html data-theme>` and the
 * browser's bar colour.
 */
export const requestTheme = cache(async (): Promise<Theme> => {
  const user = await requestUser();
  let userTheme: Theme | null = null;
  if (user) {
    try {
      userTheme = getTheme(getAuthRuntime().db, user.id);
    } catch {
      userTheme = null;
    }
  }
  return resolveTheme({ userTheme, cookieTheme: (await cookies()).get(THEME_COOKIE)?.value });
});
