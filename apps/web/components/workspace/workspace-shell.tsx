'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import type { Locale } from '../../i18n/locales.ts';
import type { BayData, BaySession } from '../../lib/sessions/types.ts';
import { SignOutButton } from '../auth/sign-out-button.tsx';
import { ChevronLeftIcon, CloseIcon } from '../icons/index.tsx';
import { LocaleSwitcher } from '../locale-switcher.tsx';
import { SkipLink } from '../skip-link.tsx';
import { ButtonLink } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { STATE_FILL } from '../ui/state.ts';
import { StatusChip } from '../ui/status-chip.tsx';
import { Wordmark } from '../ui/wordmark.tsx';
import { Bay } from './bay.tsx';
import { FirstRunPanel, PickSessionPanel } from './empty-panels.tsx';
import { KeyBar } from './key-bar.tsx';
import { NewSessionButton } from './new-session-button.tsx';

const stripHref = (id: string) => `/workspace?s=${encodeURIComponent(id)}`;

/**
 * Until the WebSocket client lands, the bay re-reads its rows whenever the tab becomes visible
 * again, so a session that changed state while you were away slides to its new lane on return.
 */
function useRefreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 2000) return;
      last = Date.now();
      router.refresh();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [router]);
}

function Tab({ session, closeHref }: { session: BaySession; closeHref: string }) {
  const t = useTranslations('workspace');
  return (
    <div className="surface-stock flex h-8 min-w-0 max-w-64 items-stretch overflow-hidden rounded-t-[3px] bg-stock-followed text-ink">
      <span aria-hidden="true" className={cx('w-1 shrink-0', STATE_FILL[session.status])} />
      <Link
        href={stripHref(session.id)}
        scroll={false}
        aria-current="page"
        className="flex min-w-0 items-center ps-2.5 pe-1.5 focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2"
      >
        <span className="truncate font-semibold font-strip text-strip">{session.label}</span>
        <span className="sr-only">, {t(`status.${session.status}`)}</span>
      </Link>
      <Link
        href={closeHref}
        scroll={false}
        aria-label={t('tabs.close')}
        title={t('tabs.close')}
        className="flex w-7 shrink-0 items-center justify-center text-ink-muted transition-colors duration-(--duration-step) ease-linear hover:bg-quiet-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2"
      >
        <CloseIcon size={14} />
      </Link>
    </div>
  );
}

export interface WorkspaceShellProps {
  bay: BayData;
  hostCount: number;
  followedId: string | null;
  renderedAt: number;
  username: string;
  locale: Locale;
  workspaceHref: string;
  hostsHref: string;
}

/**
 * The workspace frame: the bay of state lanes on the left, the slate tab bar and pane area on
 * the right. On a phone the bay is the switcher screen and an open session takes the whole
 * screen with the extra-key bar.
 */
export function WorkspaceShell({
  bay,
  hostCount,
  followedId,
  renderedAt,
  username,
  locale,
  workspaceHref,
  hostsHref,
}: WorkspaceShellProps) {
  const t = useTranslations('workspace');
  const tc = useTranslations('common');
  useRefreshOnReturn();
  const followed = bay.sessions.find((s) => s.id === followedId) ?? null;
  const firstRun = hostCount === 0;
  const view = followed ? 'pane' : 'bay';

  return (
    <div className="flex h-dvh overflow-hidden bg-board-0 text-board-ink">
      <SkipLink label={tc('skipToContent')} target={followed ? 'main' : 'bay-lanes'} />

      <aside
        aria-label={t('bay.label')}
        className={cx(
          'surface-board flex w-full min-w-0 flex-col bg-board-1 md:w-(--bay-width) md:shrink-0',
          view === 'pane' && 'max-md:hidden',
        )}
      >
        <div className="flex flex-col gap-3 px-3 pt-4 pb-3">
          <div className="flex h-7 items-center px-1">
            <Wordmark />
          </div>
          <NewSessionButton disabled={firstRun} />
        </div>

        <div id="bay-lanes" className="min-h-0 flex-1 overflow-y-auto ps-3 pe-4 pt-1 pb-4">
          {firstRun ? (
            <>
              <p className="px-1 text-board-ink-muted text-sm max-md:hidden">{t('bay.noHosts')}</p>
              <FirstRunPanel hostsHref={hostsHref} className="md:hidden" />
            </>
          ) : bay.sessions.length === 0 ? (
            <div className="flex flex-col gap-1 px-1">
              <p className="font-semibold text-board-ink text-sm">{t('bay.emptyTitle')}</p>
              <p className="text-board-ink-muted text-sm">{t('bay.emptyBody')}</p>
            </div>
          ) : (
            <Bay data={bay} followedId={followedId} renderedAt={renderedAt} stripHref={stripHref} />
          )}
        </div>

        <footer className="flex flex-col gap-2 border-board-rule border-t px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between gap-2 ps-1">
            <p className="min-w-0 truncate font-medium text-board-ink text-sm">
              <span className="sr-only">{t('account.signedInAs', { username })}</span>
              <span aria-hidden="true">{username}</span>
            </p>
            <SignOutButton label={tc('signOut')} iconOnly />
          </div>
          <LocaleSwitcher locale={locale} hideLabel fill />
        </footer>
      </aside>

      <main
        id="main"
        aria-label={t('pane.label')}
        className={cx('flex min-w-0 flex-1 flex-col bg-board-2', view === 'bay' && 'max-md:hidden')}
      >
        {followed ? (
          <div className="flex h-12 shrink-0 items-center gap-2 ps-1 pe-3 md:hidden">
            <ButtonLink
              href={workspaceHref}
              scroll={false}
              variant="quiet"
              size="sm"
              icon={<ChevronLeftIcon size={18} />}
            >
              {t('phone.back')}
            </ButtonLink>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
              <span className="truncate font-semibold font-strip text-strip">{followed.label}</span>
              <StatusChip status={followed.status} label={t(`status.${followed.status}`)} />
            </div>
          </div>
        ) : null}

        <nav
          aria-label={t('tabs.label')}
          className="flex h-(--tabbar-height) shrink-0 items-end gap-1 px-1.5 max-md:hidden"
        >
          {followed ? (
            <Tab session={followed} closeHref={workspaceHref} />
          ) : (
            <p className="self-center px-2 text-board-ink-muted text-xs">{t('tabs.empty')}</p>
          )}
        </nav>

        <div className="flex min-h-0 flex-1 flex-col md:px-1.5 md:pb-1.5">
          <div
            className={cx(
              'surface-pane relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-pane p-4 md:rounded-[3px]',
              followed && 'md:border-stock-followed md:border-t-2',
            )}
          >
            {followed ? (
              <>
                <StatusChip status={followed.status} label={t(`status.${followed.status}`)} />
                <p className="text-ink-muted text-sm">{t('pane.notAttached')}</p>
              </>
            ) : firstRun ? (
              <FirstRunPanel hostsHref={hostsHref} />
            ) : (
              <PickSessionPanel hasSessions={bay.sessions.length > 0} />
            )}
          </div>
        </div>

        {followed ? <KeyBar className="md:hidden" /> : null}
      </main>
    </div>
  );
}
