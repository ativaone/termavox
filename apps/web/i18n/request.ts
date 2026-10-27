import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { requestUser } from '../lib/auth/request-user.ts';
import { LOCALE_COOKIE, type Locale, resolveLocale } from './locales.ts';

const MESSAGES = {
  en: () => import('../messages/en.json'),
  'pt-BR': () => import('../messages/pt-BR.json'),
} satisfies Record<Locale, () => Promise<{ default: unknown }>>;

/** Server time zone, so dates never fall back silently (next-intl warns otherwise). */
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const locale = resolveLocale({
    // The signed-in user's stored locale (looked up only with a session cookie).
    userLocale: (await requestUser())?.locale ?? null,
    cookieLocale: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: requestHeaders.get('accept-language'),
  });
  return {
    locale,
    messages: (await MESSAGES[locale]()).default,
    timeZone: TIME_ZONE,
  };
});
