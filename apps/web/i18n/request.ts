import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { getAuthRuntime } from '../lib/auth/server.ts';
import { SESSION_COOKIE } from '../lib/auth-cookies.ts';
import { LOCALE_COOKIE, type Locale, resolveLocale } from './locales.ts';

const MESSAGES = {
  en: () => import('../messages/en.json'),
  'pt-BR': () => import('../messages/pt-BR.json'),
} satisfies Record<Locale, () => Promise<{ default: unknown }>>;

/** Server time zone, so dates never fall back silently (next-intl warns otherwise). */
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The signed-in user's stored locale. Only looked up when a session cookie is present, so
 * anonymous pages (and anything rendered at build time, without configuration) never touch
 * the auth runtime or the database.
 */
async function userLocale(requestHeaders: Headers): Promise<string | null> {
  try {
    const found = await getAuthRuntime().auth.api.getSession({
      headers: requestHeaders,
      query: { disableRefresh: true },
    });
    return found?.user.locale ?? null;
  } catch {
    return null;
  }
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const locale = resolveLocale({
    userLocale: cookieStore.has(SESSION_COOKIE) ? await userLocale(requestHeaders) : null,
    cookieLocale: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: requestHeaders.get('accept-language'),
  });
  return {
    locale,
    messages: (await MESSAGES[locale]()).default,
    timeZone: TIME_ZONE,
  };
});
