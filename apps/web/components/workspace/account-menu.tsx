'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon } from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';

/**
 * The bay footer's way out of the workspace: the username opens a native disclosure with the
 * secondary pages (hosts, credentials, activity, settings, admin). Inline, not a popover, so it
 * never covers a strip and needs no JavaScript.
 */
export function AccountMenu({ username, isAdmin }: { username: string; isAdmin: boolean }) {
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
    </details>
  );
}
