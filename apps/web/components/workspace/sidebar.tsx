'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useRef } from 'react';
import type { Locale } from '../../i18n/locales.ts';
import { ROUTES } from '../../lib/routes.ts';
import type { BayData, BaySession } from '../../lib/sessions/types.ts';
import { HelpButton } from '../help-links.tsx';
import {
  ActivityIcon,
  KeyIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  ServerIcon,
} from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';
import { NavIcon, NavRow } from '../ui/nav-row.tsx';
import { BrandTile, Wordmark } from '../ui/wordmark.tsx';
import { AccountMenu } from './account-menu.tsx';
import { EdgeHandle } from './edge-handle.tsx';
import { FirstRunPanel } from './empty-panels.tsx';
import { EndAllSessions } from './end-all-sessions.tsx';
import { NewSessionButton } from './new-session-button.tsx';
import { SessionList, SessionRail } from './session-list.tsx';
import type { SessionMenuActions } from './session-menu.tsx';
import type { SidebarMode } from './sidebar-preference.ts';
import { SIDEBAR_DEFAULT_PX, SIDEBAR_MAX_PX, SIDEBAR_MIN_PX } from './view-preferences.ts';

export const SESSION_LIST_ID = 'session-list';

/** Arrow-key steps on the sidebar's edge, in CSS px (Shift takes the large one). */
const EDGE_STEP_PX = 16;
const EDGE_STEP_LARGE_PX = 64;

export interface SidebarProps {
  username: string;
  isAdmin: boolean;
  locale: Locale;
  /** The running Termavox version, for the account menu's foot. */
  version: string;
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
      {rail ? <PanelLeftOpenIcon size={18} /> : <PanelLeftCloseIcon size={18} />}
    </button>
  );
}

/**
 * The session sidebar (plan D-28): the mark, New session and the collapse toggle on its own row
 * under it (D-38: the head's rows keep their heights in both modes, so the toggle stays exactly
 * where it was and the pointer stays on it), the sessions
 * grouped by state with "End all sessions…" at their foot (D-30), the management links and the
 * account row with the help button at its end (D-40). As a rail it keeps the same things as icons
 * and tiles, without End all, the help button over the avatar. On a phone it is the switcher
 * screen, full width, with the help button and the avatar in its head.
 */
export function Sidebar({
  username,
  isAdmin,
  locale,
  version,
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
        {/* The same rows as the expanded head (mark, New session, toggle), at the same heights. */}
        <div className="flex flex-col items-center gap-3 pt-3 pb-2 [view-transition-name:sidebar-head]">
          <span className="flex h-10 items-center">
            <BrandTile />
          </span>
          <div className="flex flex-col items-center gap-1">
            <span className="flex h-11 items-center">
              <NewSessionButton disabled={serverCount === 0} compact />
            </span>
            <ToggleButton rail onClick={() => onModeChange('expanded')} />
          </div>
        </div>
        <div id={SESSION_LIST_ID} className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-3">
          {list}
        </div>
        <div className="flex flex-col items-center gap-1 border-line border-t py-2 [view-transition-name:sidebar-foot]">
          {nav.map((item) => (
            <NavIcon key={item.href} href={item.href} icon={item.icon} label={item.label} />
          ))}
          <HelpButton />
          <AccountMenu
            username={username}
            isAdmin={isAdmin}
            locale={locale}
            version={version}
            compact
          />
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
          <Wordmark className="ps-1 md:ps-0" />
          <span className="flex-1" />
          <HelpButton className="md:hidden" />
          <span className="md:hidden">
            <AccountMenu
              username={username}
              isAdmin={isAdmin}
              locale={locale}
              version={version}
              compact
              placement="below"
            />
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex h-11 items-center">
            <NewSessionButton disabled={serverCount === 0} />
          </div>
          {/* Pulled 2 px out to the rail's centred column, so collapsing never moves it. */}
          <ToggleButton
            rail={false}
            onClick={() => onModeChange('rail')}
            className="-ms-0.5 max-md:hidden"
          />
        </div>
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
        <div className="flex items-center gap-1 max-md:hidden">
          <div className="min-w-0 flex-1">
            <AccountMenu username={username} isAdmin={isAdmin} locale={locale} version={version} />
          </div>
          <HelpButton />
        </div>
      </div>
    </aside>
  );
}

/**
 * The rule between the sidebar and the workspace, drawn like the file panel's divider. Beside
 * the full list it is the list's resize handle (drag or arrows; double-click restores the
 * default width); beside the rail it is only the rule, so switching modes never shifts the
 * workspace. Hidden on a phone, where the sidebar is the whole screen.
 */
export function SidebarEdge({
  rail,
  width,
  onPreview,
  onCommit,
}: {
  rail: boolean;
  /** The stored width in CSS px, or null for the default. */
  width: number | null;
  onPreview(width: number | null): void;
  onCommit(width: number | null): void;
}) {
  const t = useTranslations('workspace.sidebar');
  const drag = useRef<{ from: number; max: number; value: number | null } | null>(null);
  if (rail) {
    return (
      <div aria-hidden="true" className="relative flex w-2 shrink-0 justify-center max-md:hidden">
        <span className="absolute inset-y-0 w-px bg-line" />
      </div>
    );
  }

  const maxWidth = (): number =>
    Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, window.innerWidth / 2));
  const clamp = (value: number, max: number): number =>
    Math.min(max, Math.max(SIDEBAR_MIN_PX, value));
  /** The sidebar's drawn width: the edge starts where the sidebar ends. */
  const measure = (handle: HTMLElement): number =>
    handle.getBoundingClientRect().left - (handle.parentElement?.getBoundingClientRect().left ?? 0);

  return (
    <EdgeHandle
      ruled
      label={t('resize')}
      value={width ?? SIDEBAR_DEFAULT_PX}
      min={SIDEBAR_MIN_PX}
      max={SIDEBAR_MAX_PX}
      className="relative max-md:hidden"
      onPress={(handle) => {
        drag.current = { from: measure(handle), max: maxWidth(), value: null };
      }}
      onDrag={(dx) => {
        const state = drag.current;
        if (!state) return;
        state.value = clamp(state.from + dx, state.max);
        onPreview(state.value);
      }}
      onRelease={() => {
        const value = drag.current?.value ?? null;
        drag.current = null;
        onPreview(null);
        if (value !== null) onCommit(value);
      }}
      onKey={(key, large, handle) => {
        const max = maxWidth();
        const step = large ? EDGE_STEP_LARGE_PX : EDGE_STEP_PX;
        let next: number;
        if (key === 'home') next = SIDEBAR_MIN_PX;
        else if (key === 'end') next = max;
        else next = measure(handle) + (key === 'back' ? -step : step);
        onCommit(clamp(next, max));
      }}
      onReset={() => onCommit(null)}
    />
  );
}
