'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { Locale } from '../../i18n/locales.ts';
import { ChevronDownIcon } from '../icons/index.tsx';
import { LocaleSwitcher } from '../locale-switcher.tsx';
import { cx } from '../ui/cx.ts';

/**
 * The bay footer's way out of the workspace: the username opens a native disclosure with the
 * secondary pages (hosts, credentials, activity, settings, admin). Inline, not a popover, so it
 * never covers a strip and needs no JavaScript. On a phone it also holds the language picker,
 * which the desktop bay keeps in its footer.
 */
export function AccountMenu({
  username,
  isAdmin,
  locale,
}: {
  username: string;
  isAdmin: boolean;
  locale: Locale;
}) {
  const t = useTranslations('nav');
  const links = [
    { href: '/hosts', label: t('hosts') },
    { href: '/credentials', label: t('credentials') },
    { href: '/activity', label: t('activity') },
    { href: '/settings/account', label: t('settings') },
    ...(isAdmin ? [{ href: '/admin/users', label: t('admin') }] : []),
  ];
  return (
    <details className="group min-w-0 flex-1">
      <summary
        className={cx(
          'flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-control px-1 [&::-webkit-details-marker]:hidden',
          'transition-colors duration-(--duration-step) ease-linear hover:bg-quiet-hover',
          'focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2',
        )}
      >
        <span className="sr-only">{t('menu')}, </span>
        <span className="sr-only">{t('signedInAs', { username })}</span>
        <span aria-hidden="true" className="min-w-0 truncate font-medium text-board-ink text-sm">
          {username}
        </span>
        <ChevronDownIcon
          size={14}
          className="shrink-0 text-board-ink-muted transition-transform duration-(--duration-step) group-open:rotate-180"
        />
      </summary>
      {/* On a phone the body also spans the sign-out column (2rem + the row's 0.5rem gap), so the
          rule and the language picker end on the footer's gutter like the strips above. */}
      <div className="max-md:-me-10">
        <nav aria-label={t('label')} className="pt-1 pb-1">
          <ul className="flex flex-col">
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={cx(
                    'flex h-8 items-center rounded-control px-2 text-board-ink-muted text-sm',
                    'transition-colors duration-(--duration-step) ease-linear hover:bg-quiet-hover hover:text-board-ink',
                    'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                  )}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <LocaleSwitcher
          locale={locale}
          fill
          className="mx-1 mt-1 border-board-rule border-t pt-2 pb-1 md:hidden"
        />
      </div>
    </details>
  );
}
