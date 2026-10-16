import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SignOutButton } from '../auth/sign-out-button.tsx';
import { ChevronLeftIcon } from '../icons/index.tsx';
import { SkipLink } from '../skip-link.tsx';
import { ButtonLink } from '../ui/button.tsx';
import { ManageNav, type NavItem } from './manage-nav.tsx';

/**
 * Frame of the secondary pages (hosts, credentials, activity, settings, admin): a slim slate bar
 * that leads back to the workspace first (the terminal comes first), the section links, and the
 * account. Content sits on the board ground in stock sheets.
 */
export async function ManageShell({
  username,
  isAdmin,
  children,
}: {
  username: string;
  isAdmin: boolean;
  children: ReactNode;
}) {
  const t = await getTranslations('nav');
  const tc = await getTranslations('common');
  const items: NavItem[] = [
    { href: '/hosts', label: t('hosts') },
    { href: '/credentials', label: t('credentials') },
    { href: '/activity', label: t('activity') },
    { href: '/settings/account', label: t('settings'), match: '/settings' },
    ...(isAdmin ? [{ href: '/admin/users', label: t('admin'), match: '/admin' }] : []),
  ];
  return (
    <div className="surface-board flex min-h-dvh flex-col bg-board-0 text-board-ink">
      <SkipLink label={tc('skipToContent')} />
      <header className="border-board-rule border-b bg-board-1">
        <div className="mx-auto flex h-12 w-full max-w-[76rem] items-stretch gap-2 px-2 sm:px-4">
          <div className="flex items-center">
            <ButtonLink
              href="/workspace"
              variant="quiet"
              size="sm"
              icon={<ChevronLeftIcon size={18} />}
            >
              {t('workspace')}
            </ButtonLink>
          </div>
          <span aria-hidden="true" className="my-3.5 w-px bg-board-rule max-md:hidden" />
          <ManageNav items={items} label={t('label')} className="max-md:hidden" />
          <div className="ms-auto flex min-w-0 items-center gap-1">
            <p className="min-w-0 truncate px-1 font-medium text-board-ink text-sm">
              <span className="sr-only">{t('signedInAs', { username })}</span>
              <span aria-hidden="true">{username}</span>
            </p>
            <SignOutButton label={tc('signOut')} iconOnly />
          </div>
        </div>
        <div className="overflow-x-auto px-2 md:hidden">
          <ManageNav items={items} label={t('label')} className="h-10" />
        </div>
      </header>
      <main
        id="main"
        className="mx-auto flex w-full max-w-[76rem] flex-1 flex-col gap-6 px-4 pt-6 pb-12 md:pt-8"
      >
        {children}
      </main>
    </div>
  );
}
