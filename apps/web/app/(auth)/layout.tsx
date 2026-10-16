import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { LocaleSwitcher } from '../../components/locale-switcher.tsx';
import { SkipLink } from '../../components/skip-link.tsx';
import { Wordmark } from '../../components/ui/wordmark.tsx';
import { isLocale } from '../../i18n/locales.ts';

/** The board every auth surface sits on: mark, one stock sheet, the language picker. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('common');
  const locale = await getLocale();
  return (
    <div className="surface-board flex min-h-dvh flex-col bg-board-0">
      <SkipLink label={t('skipToContent')} />
      <header className="flex justify-center px-4 pt-10 sm:pt-16">
        <Wordmark />
      </header>
      <main id="main" className="flex flex-1 justify-center px-4 pt-8 pb-10 sm:pt-10">
        {children}
      </main>
      <footer className="flex justify-center px-4 pb-8">
        <LocaleSwitcher locale={isLocale(locale) ? locale : 'en'} />
      </footer>
    </div>
  );
}
