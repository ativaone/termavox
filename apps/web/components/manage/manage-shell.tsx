import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { isLocale } from '../../i18n/locales.ts';
import { ROUTES } from '../../lib/routes.ts';
import { HelpButton } from '../help-links.tsx';
import {
  ActivityIcon,
  KeyIcon,
  ServerIcon,
  SettingsIcon,
  TerminalIcon,
  UsersIcon,
} from '../icons/index.tsx';
import { SkipLink } from '../skip-link.tsx';
import { Wordmark } from '../ui/wordmark.tsx';
import { AccountMenu } from '../workspace/account-menu.tsx';
import { ManageNav, ManageNavRow, type NavItem } from './manage-nav.tsx';

/**
 * Frame of the secondary pages (hosts, credentials, activity, settings, admin): the same
 * sidebar vocabulary as the workspace, with the workspace first (the terminal comes first), the
 * section rows, and the account menu at the foot with the help button at its end (plan D-40). On
 * a phone the sidebar folds into a top bar (the help button, the avatar) with a sideways row of
 * links. Content sits on the ground in cards.
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
  const locale = await getLocale();
  const current = isLocale(locale) ? locale : 'en';
  const items: NavItem[] = [
    { href: '/workspace', label: t('workspace'), icon: <TerminalIcon size={16} /> },
    { href: ROUTES.servers, label: t('servers'), icon: <ServerIcon size={16} /> },
    { href: '/credentials', label: t('credentials'), icon: <KeyIcon size={16} /> },
    { href: '/activity', label: t('activity'), icon: <ActivityIcon size={16} /> },
    {
      href: '/settings/account',
      label: t('settings'),
      icon: <SettingsIcon size={16} />,
      match: '/settings',
    },
    ...(isAdmin
      ? [
          {
            href: '/admin/users',
            label: t('admin'),
            icon: <UsersIcon size={16} />,
            match: '/admin',
          },
        ]
      : []),
  ];
  return (
    <div className="ground-glow flex min-h-dvh flex-col text-ink md:flex-row">
      <SkipLink label={tc('skipToContent')} />
      <aside className="flex shrink-0 flex-col md:sticky md:top-0 md:h-dvh md:w-(--sidebar-width)">
        <div className="flex h-14 items-center justify-between gap-2 px-4 md:h-16">
          <Wordmark />
          <span className="flex items-center gap-1 md:hidden">
            <HelpButton />
            <AccountMenu
              username={username}
              isAdmin={isAdmin}
              locale={current}
              compact
              placement="below"
            />
          </span>
        </div>
        <div className="md:hidden">
          <ManageNavRow items={items} label={t('label')} />
        </div>
        <div className="hidden min-h-0 flex-1 flex-col px-3 pb-2 md:flex">
          <ManageNav items={items} label={t('label')} />
          <span className="flex-1" />
          <div className="flex items-center gap-1 border-line border-t pt-2">
            <div className="min-w-0 flex-1">
              <AccountMenu username={username} isAdmin={isAdmin} locale={current} />
            </div>
            <HelpButton />
          </div>
        </div>
      </aside>
      <main
        id="main"
        className="mx-auto flex w-full min-w-0 max-w-[76rem] flex-1 flex-col gap-6 px-4 pt-4 pb-12 md:px-8 md:pt-8"
      >
        {children}
      </main>
    </div>
  );
}
