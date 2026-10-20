'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import type { Locale } from '../../i18n/locales.ts';
import { signOut } from '../../lib/actions/auth.ts';
import { REPOSITORY_URL } from '../../lib/links.ts';
import {
  ExternalLinkIcon,
  GitHubIcon,
  GlobeIcon,
  SettingsIcon,
  SignOutIcon,
  TerminalIcon,
  UserIcon,
  UsersIcon,
} from '../icons/index.tsx';
import { Avatar } from '../ui/avatar.tsx';
import { cx } from '../ui/cx.ts';
import {
  MENU_ITEM_CLASSES,
  MENU_ITEM_QUIET_CLASSES,
  MenuItem,
  MenuLabel,
  MenuLink,
  MenuPopover,
  MenuSeparator,
  usePopoverMenu,
} from '../ui/menu.tsx';
import { LanguageDialog } from './language-dialog.tsx';

const MENU_WIDTH = 248;

/**
 * The account menu (plan D-28): the user's name with a gear opens settings (account, terminal,
 * and "Language…", which opens the language dialog), Admin for administrators, and Sign out,
 * then a smaller, quieter row to the source code on GitHub in a new tab (plan D-40) and, under it,
 * the running version as plain text (not a menu item). A native popover, placed above or below its
 * control; sign-out stays a form post. `compact` shows the avatar alone (the rail, the phone
 * header). `version` comes from a server component that required a session (lib/version.ts), so
 * it never reaches a signed-out visitor.
 */
export function AccountMenu({
  username,
  isAdmin,
  locale,
  version,
  compact = false,
  placement = 'above',
  className,
}: {
  username: string;
  isAdmin: boolean;
  locale: Locale;
  /** The running Termavox version, shown at the menu's foot. */
  version: string;
  compact?: boolean;
  /** Preferred side; the menu flips when there is no room. */
  placement?: 'above' | 'below';
  className?: string;
}) {
  const t = useTranslations('workspace.account');
  const tn = useTranslations('nav');
  const tc = useTranslations('common');
  const th = useTranslations('help');
  const menu = usePopoverMenu({ width: MENU_WIDTH, align: compact ? 'start' : 'end' });
  const languageRef = useRef<HTMLDialogElement>(null);

  const openLanguage = () => {
    menu.hide();
    // The anchor takes the focus first, so closing the dialog gives it back there.
    menu.anchorRef.current?.focus();
    languageRef.current?.showModal();
  };

  return (
    <>
      <button
        ref={menu.anchorRef}
        id={menu.buttonId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.menuId}
        aria-label={compact ? `${t('menu')}. ${t('signedInAs', { username })}` : undefined}
        title={compact ? username : undefined}
        onClick={menu.toggle}
        data-placement={placement}
        className={cx(
          'flex items-center gap-2.5 rounded-control text-start',
          'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
          compact ? 'size-9 justify-center' : 'h-11 w-full ps-2 pe-2',
          menu.open && 'bg-surface-raised',
          className,
        )}
      >
        <Avatar name={username} />
        {compact ? null : (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="sr-only">{t('menu')}, </span>
              <span className="sr-only">{t('signedInAs', { username })}</span>
              <span aria-hidden="true" className="truncate font-semibold text-ink text-sm">
                {username}
              </span>
            </span>
            <SettingsIcon size={16} className="shrink-0 text-ink-muted" />
          </>
        )}
      </button>
      <MenuPopover menu={menu} width={MENU_WIDTH}>
        <div role="menu" aria-labelledby={menu.buttonId} onKeyDown={menu.onKeyDown} className="p-1">
          <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
            <Avatar name={username} />
            <span className="min-w-0 truncate font-semibold text-ink text-sm">{username}</span>
          </div>
          <MenuSeparator />
          <MenuLabel>{tn('settings')}</MenuLabel>
          <MenuLink Component={Link} href="/settings/account" icon={<UserIcon size={16} />}>
            {t('accountSettings')}
          </MenuLink>
          <MenuLink Component={Link} href="/settings/terminal" icon={<TerminalIcon size={16} />}>
            {t('terminalSettings')}
          </MenuLink>
          <MenuItem icon={<GlobeIcon size={16} />} onClick={openLanguage}>
            {t('language')}
          </MenuItem>
          {isAdmin ? (
            <>
              <MenuSeparator />
              <MenuLink Component={Link} href="/admin/users" icon={<UsersIcon size={16} />}>
                {tn('admin')}
              </MenuLink>
            </>
          ) : null}
          <MenuSeparator spaced />
          <form action={signOut} className="contents">
            <button type="submit" role="menuitem" tabIndex={-1} className={MENU_ITEM_CLASSES}>
              <span className="flex w-4 shrink-0 justify-center text-ink-muted">
                <SignOutIcon size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate">{tc('signOut')}</span>
            </button>
          </form>
          <MenuSeparator />
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            tabIndex={-1}
            onClick={menu.hide}
            className={MENU_ITEM_QUIET_CLASSES}
          >
            <span className="flex w-4 shrink-0 justify-center">
              <GitHubIcon size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {th('source')}
              <span className="sr-only"> {th('newTab')}</span>
            </span>
            <ExternalLinkIcon size={12} className="shrink-0" />
          </a>
          {/* Information, not an action: never focused, aligned with the text of the row above. */}
          <p role="presentation" className="ps-9 pe-2.5 pt-0.5 pb-1.5 text-ink-muted text-xs">
            {t.rich('version', {
              version,
              data: (chunks) => <span className="font-data">{chunks}</span>,
            })}
          </p>
        </div>
      </MenuPopover>
      <LanguageDialog dialogRef={languageRef} locale={locale} />
    </>
  );
}
