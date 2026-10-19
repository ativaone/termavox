'use client';

import { useLocale, useTranslations } from 'next-intl';
import { isLocale, type Locale } from '../i18n/locales.ts';
import { docsUrl, type HelpSection, helpUrl } from '../lib/links.ts';
import { ExternalLinkIcon, HelpIcon } from './icons/index.tsx';
import { cx } from './ui/cx.ts';

/**
 * The ways out to the project site (plan D-40), always in a new tab: the help button beside the
 * account menu, and the quiet "Learn more" links that open the user guide at one of its sections
 * where a state needs more than its one line.
 */

function useSiteLocale(): Locale {
  const locale = useLocale();
  return isLocale(locale) ? locale : 'en';
}

/** A 36 px quiet icon button, drawn like the sidebar's collapse toggle; opens the documentation. */
export function HelpButton({ className }: { className?: string }) {
  const t = useTranslations('help');
  const locale = useSiteLocale();
  return (
    <a
      href={docsUrl(locale)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${t('label')} ${t('newTab')}`}
      title={t('label')}
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-control text-ink-muted',
        'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised hover:text-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        className,
      )}
    >
      <HelpIcon size={18} />
    </a>
  );
}

/**
 * "Learn more" at a section of the user guide. `link` (the default) is the inline link of muted
 * prose, in the accent; `action` inherits the ink of a notice, like the text actions beside it.
 */
export function LearnMore({
  section,
  tone = 'link',
  className,
}: {
  section: HelpSection;
  tone?: 'link' | 'action';
  className?: string;
}) {
  const t = useTranslations('help');
  const locale = useSiteLocale();
  return (
    <a
      href={helpUrl(locale, section)}
      target="_blank"
      rel="noopener noreferrer"
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap',
        tone === 'action'
          ? 'font-semibold underline underline-offset-2'
          : 'font-medium text-accent underline decoration-accent/50 underline-offset-4 hover:decoration-accent',
        className,
      )}
    >
      {t('learnMore')}
      <span className="sr-only"> {t('newTab')}</span>
      <ExternalLinkIcon size={12} className="shrink-0" />
    </a>
  );
}
