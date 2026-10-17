'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { Locale } from '../../i18n/locales.ts';
import { ROUTES } from '../../lib/routes.ts';
import type { BayData, BaySession } from '../../lib/sessions/types.ts';
import { ActivityIcon, KeyIcon, PanelLeftIcon, ServerIcon } from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';
import { NavIcon, NavRow } from '../ui/nav-row.tsx';
import { BrandTile, Wordmark } from '../ui/wordmark.tsx';
import { AccountMenu } from './account-menu.tsx';
import { FirstRunPanel } from './empty-panels.tsx';
import { EndAllSessions } from './end-all-sessions.tsx';
import { NewSessionButton } from './new-session-button.tsx';
import { SessionList, SessionRail } from './session-list.tsx';
import type { SessionMenuActions } from './session-menu.tsx';
import type { SidebarMode } from './sidebar-preference.ts';

export const SESSION_LIST_ID = 'session-list';

export interface SidebarProps {
  username: string;
  isAdmin: boolean;
  locale: Locale;
  serverCount: number;
  data: BayData;
  followedId: string | null;
  renderedAt: number;
  sessionHref: (id: string) => string;
  onFollow: (sessionId: string) => void;
  menuActions: (session: BaySession) => SessionMenuActions;
  desktop: boolean;
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  /** Hidden on a phone while a session is open full screen. */
  hidden?: boolean;
}

function ToggleButton({
  rail,
  onClick,
  className,
}: {
  rail: boolean;
  onClick: () => void;
  className?: string;
}) {
  const t = useTranslations('workspace.sidebar');
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={!rail}
      aria-controls={SESSION_LIST_ID}
      aria-label={rail ? t('expand') : t('collapse')}
      title={rail ? t('expand') : t('collapse')}
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-control text-ink-muted',
        'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised hover:text-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        className,
      )}
    >
      <PanelLeftIcon size={18} />
    </button>
  );
}

/**
 * The session sidebar (plan D-28): the mark and the collapse toggle, New session, the sessions
 * grouped by state with "End all sessions…" at their foot (D-30), the management links and the
 * account row. As a rail it keeps the same things as icons and tiles, without End all. On a phone
 * it is the switcher screen, full width.
 */
export function Sidebar({
  username,
  isAdmin,
  locale,
  serverCount,
  data,
  followedId,
  renderedAt,
  sessionHref,
  onFollow,
  menuActions,
  desktop,
  mode,
  onModeChange,
  hidden = false,
}: SidebarProps) {
  const t = useTranslations('workspace');
  const tn = useTranslations('nav');
  const rail = desktop && mode === 'rail';
  const liveCount = data.sessions.filter((s) => s.status !== 'ended').length;
  const nav = [
    { href: ROUTES.servers, label: tn('servers'), icon: <ServerIcon size={16} /> },
    { href: '/credentials', label: tn('credentials'), icon: <KeyIcon size={16} /> },
    { href: '/activity', label: tn('activity'), icon: <ActivityIcon size={16} /> },
  ];

  let list: ReactNode;
  if (serverCount === 0) {
    list = rail ? null : (
      <>
        <p className="px-2.5 text-ink-muted text-sm max-md:hidden">{t('bay.noServers')}</p>
        <FirstRunPanel className="md:hidden" />
      </>
    );
  } else if (data.sessions.length === 0) {
    list = rail ? null : (
      <div className="flex flex-col gap-1 px-2.5">
        <p className="font-semibold text-ink text-sm">{t('bay.emptyTitle')}</p>
        <p className="text-ink-muted text-sm">{t('bay.emptyBody')}</p>
      </div>
    );
  } else if (rail) {
    list = (
      <SessionRail
        data={data}
        followedId={followedId}
        sessionHref={sessionHref}
        onFollow={onFollow}
        menuActions={menuActions}
        desktop={desktop}
      />
    );
  } else {
    list = (
      <SessionList
        data={data}
        followedId={followedId}
        renderedAt={renderedAt}
        sessionHref={sessionHref}
        onFollow={onFollow}
        menuActions={menuActions}
        desktop={desktop}
      />
    );
  }

  if (rail) {
    return (
      <aside
        aria-label={t('bay.label')}
        data-sidebar="rail"
        className="flex w-(--rail-width) shrink-0 flex-col items-center"
      >
        <div className="flex flex-col items-center gap-1.5 pt-3 pb-2 [view-transition-name:sidebar-head]">
          <span className="flex h-10 items-center">
            <BrandTile />
          </span>
          <ToggleButton rail onClick={() => onModeChange('expanded')} />
          <NewSessionButton disabled={serverCount === 0} compact />
        </div>
        <div id={SESSION_LIST_ID} className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-3">
          {list}
        </div>
        <div className="flex flex-col items-center gap-1 border-line border-t py-2 [view-transition-name:sidebar-foot]">
          {nav.map((item) => (
            <NavIcon key={item.href} href={item.href} icon={item.icon} label={item.label} />
          ))}
          <AccountMenu username={username} isAdmin={isAdmin} locale={locale} compact />
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label={t('bay.label')}
      data-sidebar="expanded"
      className={cx(
        'flex w-full min-w-0 flex-col md:w-(--sidebar-width) md:shrink-0',
        hidden && 'max-md:hidden',
      )}
    >
      {/* The head and the foot ride above a sliding row (globals.css, sidebar-head/foot). */}
      <div className="flex flex-col gap-3 px-3 pt-3 pb-2 [view-transition-name:sidebar-head]">
        <div className="flex h-10 items-center gap-1">
          <ToggleButton
            rail={false}
            onClick={() => onModeChange('rail')}
            className="max-md:hidden"
          />
          <Wordmark className="ps-1 md:ps-0" />
          <span className="flex-1" />
          <span className="md:hidden">
            <AccountMenu
              username={username}
              isAdmin={isAdmin}
              locale={locale}
              compact
              placement="below"
            />
          </span>
        </div>
        <NewSessionButton disabled={serverCount === 0} />
      </div>

      <div id={SESSION_LIST_ID} className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
        {list}
        {serverCount > 0 && liveCount > 0 ? (
          <div className="pt-3">
            <EndAllSessions count={liveCount} />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1 border-line border-t px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] [view-transition-name:sidebar-foot]">
        <nav aria-label={tn('label')}>
          <ul className="flex flex-col gap-0.5">
            {nav.map((item) => (
              <li key={item.href}>
                <NavRow href={item.href} icon={item.icon}>
                  {item.label}
                </NavRow>
              </li>
            ))}
          </ul>
        </nav>
        <div className="max-md:hidden">
          <AccountMenu username={username} isAdmin={isAdmin} locale={locale} />
        </div>
      </div>
    </aside>
  );
}
