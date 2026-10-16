/**
 * Supported UI locales and the resolution order of plan §8.4: the signed-in user's preference
 * (`user.locale`), then the `NEXT_LOCALE` cookie written by the locale switcher, then the
 * browser's `Accept-Language`, then English. Pure and browser-safe so tests and client
 * components can share it.
 */
export const LOCALES = ['en', 'pt-BR'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const LOCALE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Maps a language tag to a supported locale by its primary subtag (`pt-PT` → `pt-BR`). */
function matchTag(tag: string): Locale | null {
  const primary = tag.trim().toLowerCase().split('-')[0];
  if (primary === 'pt') return 'pt-BR';
  if (primary === 'en') return 'en';
  return null;
}

/** The best supported locale in an `Accept-Language` header, honouring q-values. */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) {
    const locale = matchTag(entry.tag);
    if (locale) return locale;
  }
  return null;
}

export interface LocaleSources {
  userLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}

export function resolveLocale(sources: LocaleSources): Locale {
  if (isLocale(sources.userLocale)) return sources.userLocale;
  if (isLocale(sources.cookieLocale)) return sources.cookieLocale;
  return matchAcceptLanguage(sources.acceptLanguage) ?? DEFAULT_LOCALE;
}
