import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { LocaleSwitcher } from '../../components/locale-switcher.tsx';
import { SkipLink } from '../../components/skip-link.tsx';
import { Wordmark } from '../../components/ui/wordmark.tsx';
import { isLocale } from '../../i18n/locales.ts';

/**
 * The ground every auth surface sits on: the mark, one card, and a discreet language control in
 * the top corner (a signed-out visitor must still be able to switch).
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('common');
  const locale = await getLocale();
  return (
    <div className="ground-glow relative flex min-h-dvh flex-col">
      <SkipLink label={t('skipToContent')} />
      <div className="absolute top-3 end-3 sm:top-4 sm:end-4">
        <LocaleSwitcher locale={isLocale(locale) ? locale : 'en'} discreet />
      </div>
      <header className="flex justify-center px-4 pt-14 sm:pt-16">
        <Wordmark />
      </header>
      <main id="main" className="flex flex-1 justify-center px-4 pt-8 pb-10 sm:pt-10">
        {children}
      </main>
    </div>
  );
}
