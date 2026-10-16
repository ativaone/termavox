'use client';

import { CloseCode } from '@termdock/protocol/client';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Locale } from '../../i18n/locales.ts';
import {
  createSession,
  reopenSession,
  retrySession,
  terminateSession,
} from '../../lib/actions/sessions.ts';
import type { TerminalPreferences } from '../../lib/preferences/terminal.ts';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import { toBayData } from '../../lib/sessions/live.ts';
import type { BayData, BaySession } from '../../lib/sessions/types.ts';
import { TermdockConnection } from '../../lib/terminal/index.ts';
import { useConnectionState } from '../../lib/terminal/react.ts';
import { encodeKey, type TerminalKey } from '../../lib/workspace/keys.ts';
import {
  fetchLayoutTransport,
  LayoutSync,
  type StoredLayout,
} from '../../lib/workspace/layout-sync.ts';
import {
  activeLeaf,
  canOpenTab,
  canSplit,
  findSession,
  type LayoutAction,
  leaves,
  newId,
} from '../../lib/workspace/tree.ts';
import { SignOutButton } from '../auth/sign-out-button.tsx';
import { ChevronLeftIcon, RetryIcon } from '../icons/index.tsx';
import { LocaleSwitcher } from '../locale-switcher.tsx';
import { SkipLink } from '../skip-link.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Notice } from '../ui/notice.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { StatusChip } from '../ui/status-chip.tsx';
import { ProtectionMark } from '../ui/strip.tsx';
import { Wordmark } from '../ui/wordmark.tsx';
import { AccountMenu } from './account-menu.tsx';
import { Bay } from './bay.tsx';
import { FirstRunPanel, PickSessionPanel } from './empty-panels.tsx';
import {
  clampCreateViewport,
  estimateViewport,
  goToLogin,
  useAuthSessionSlide,
  useHydrated,
  useIsDesktop,
  useNow,
  useTerminalAppearance,
  useVisualViewportHeight,
} from './hooks.ts';
import { KeyBar } from './key-bar.tsx';
import { NEW_SESSION_EVENT, NewSessionButton } from './new-session-button.tsx';
import { CommandPalette, type PaletteProfile, type PaletteSession } from './palette.tsx';
import { PaneTree } from './pane-tree.tsx';
import { TabBar } from './tab-bar.tsx';
import { isPaletteShortcut, TerminalPane } from './terminal-pane.tsx';
import {
  type PaneHandle,
  type PaneMeta,
  type PanePlace,
  type SessionActionKind,
  type WorkspaceContextValue,
  WorkspaceProvider,
} from './workspace-context.tsx';

const stripHref = (id: string) => `/workspace?s=${encodeURIComponent(id)}`;
const PHONE_PANE = 'phone';
const NOTICE_MS = 8_000;

export interface WorkspaceShellProps {
  bay: BayData;
  hostCount: number;
  renderedAt: number;
  username: string;
  locale: Locale;
  workspaceHref: string;
  hostsHref: string;
  loginHref: string;
  /** Shows the Admin entry in the account menu. */
  isAdmin?: boolean;
  /** The saved layout and its version (first paint; the client never refetches on load). */
  initialLayout: StoredLayout;
  profiles: PaletteProfile[];
  preferences: TerminalPreferences;
}

/** The tab's own WebSocket state, on the trailing edge of the tab bar and the phone header. */
function ConnectionChip({ connection }: { connection: TermdockConnection }) {
  const t = useTranslations('workspace.connection');
  const state = useConnectionState(connection);
  const now = useNow(1_000, state.status === 'reconnecting');
  if (state.shuttingDown && state.status !== 'open') {
    return (
      <span role="status" className="flex items-center gap-1.5 text-board-ink-muted text-xs">
        <Spinner size={13} />
        {t('restarting')}
      </span>
    );
  }
  if (state.status !== 'reconnecting') return null;
  const seconds = state.retryAt ? Math.max(0, Math.ceil((state.retryAt - now) / 1_000)) : 0;
  return (
    <span role="status" className="flex items-center gap-2 text-board-ink-muted text-xs">
      <span className="tabular-nums">
        {seconds > 0 ? t('offlineIn', { seconds }) : t('offline')}
      </span>
      <Button
        variant="quiet"
        size="sm"
        icon={<RetryIcon size={14} />}
        onClick={() => connection.retryNow()}
      >
        {t('retryNow')}
      </Button>
    </span>
  );
}

/** Non-retryable connection failures (the auth session one navigates to the login page). */
function ConnectionFailure({ connection }: { connection: TermdockConnection }) {
  const t = useTranslations('workspace.connection');
  const { error } = useConnectionState(connection);
  if (!error || error.kind === 'unauthenticated') return null;
  return (
    <div className="px-1.5 pb-1.5 max-md:px-2 max-md:pt-2">
      <Notice
        tone="danger"
        title={t(error.kind === 'forbidden' ? 'forbiddenTitle' : 'outdatedTitle')}
      >
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span>{t(error.kind === 'forbidden' ? 'forbiddenBody' : 'outdatedBody')}</span>
          <button
            type="button"
            className="font-semibold underline underline-offset-2"
            onClick={() => window.location.reload()}
          >
            {t('reload')}
          </button>
        </span>
      </Notice>
    </div>
  );
}

/**
 * 4429: this user already has too many Termdock windows connected. The connection keeps
 * retrying on a long backoff (the countdown and Retry now sit in the tab bar on desktop).
 */
function ConnectionLimit({ connection }: { connection: TermdockConnection }) {
  const t = useTranslations('workspace.connection');
  const { status, closeCode, error } = useConnectionState(connection);
  if (status === 'open' || error || closeCode !== CloseCode.RateLimited) return null;
  return (
    <div className="px-1.5 pb-1.5 max-md:px-2 max-md:pt-2">
      <Notice tone="warning">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span>{t('tooManyWindows')}</span>
          <button
            type="button"
            className="font-semibold underline underline-offset-2 md:hidden"
            onClick={() => connection.retryNow()}
          >
            {t('retryNow')}
          </button>
        </span>
      </Notice>
    </div>
  );
}

/**
 * The live workspace: the bay of state lanes (left), the slate tab bar over the split panes
 * (right), one WebSocket for the whole browser tab. On a phone the bay is the switcher and a
 * session opens alone, full screen, with the extra-key bar, without touching the desktop
 * layout. First paint comes from the server (bay rows, saved layout); the live store takes over
 * once the session list arrives.
 */
export function WorkspaceShell({
  bay: serverBay,
  hostCount,
  renderedAt,
  username,
  locale,
  workspaceHref,
  hostsHref,
  loginHref,
  isAdmin = false,
  initialLayout,
  profiles,
  preferences,
}: WorkspaceShellProps) {
  const t = useTranslations('workspace');
  const tc = useTranslations('common');
  const isDesktop = useIsDesktop();
  const hydrated = useHydrated();
  const urlSession = useSearchParams().get('s');

  // ── connection and layout ─────────────────────────────────────────────────
  const [connection] = useState(() => new TermdockConnection());
  useEffect(() => {
    connection.connect();
    return () => connection.close();
  }, [connection]);
  const connectionState = useConnectionState(connection);
  useEffect(() => {
    if (connectionState.error?.kind === 'unauthenticated') goToLogin(loginHref);
  }, [connectionState.error, loginHref]);
  useAuthSessionSlide(loginHref);

  const [sync] = useState(
    () =>
      new LayoutSync(initialLayout, fetchLayoutTransport, {
        onUnauthenticated: () => goToLogin(loginHref),
      }),
  );
  const layout = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);
  useEffect(() => {
    const exit = () => sync.flushOnExit();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') exit();
    };
    window.addEventListener('pagehide', exit);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', exit);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sync]);

  const appearance = useTerminalAppearance(preferences);
  const sessions = useMemo(
    () => new Map(connectionState.sessions.map((s) => [s.id, s])),
    [connectionState.sessions],
  );
  const bay = useMemo(
    () => (connectionState.sessionsLoaded ? toBayData(connectionState.sessions) : serverBay),
    [connectionState.sessionsLoaded, connectionState.sessions, serverBay],
  );

  // ── panes ──────────────────────────────────────────────────────────────────
  const handles = useRef(new Map<string, PaneHandle>());
  const registerPane = useCallback((paneId: string, handle: PaneHandle | null) => {
    if (handle) handles.current.set(paneId, handle);
    else handles.current.delete(paneId);
  }, []);
  const [paneMeta, setPaneMetaState] = useState<Record<string, PaneMeta>>({});
  const setPaneMeta = useCallback((paneId: string, patch: Partial<PaneMeta>) => {
    setPaneMetaState((previous) => {
      const current = previous[paneId] ?? { title: null, bell: false };
      const next = { ...current, ...patch };
      if (next.title === current.title && next.bell === current.bell) return previous;
      return { ...previous, [paneId]: next };
    });
  }, []);
  const [focusRequest, setFocusRequest] = useState<{ paneId: string; seq: number } | null>(null);
  const requestFocus = useCallback((paneId: string) => {
    setFocusRequest((request) => ({ paneId, seq: (request?.seq ?? 0) + 1 }));
  }, []);

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const current = activeLeaf(layout);
  const activePaneId = current?.leaf.id ?? null;
  // The bell is for panes you were not looking at.
  useEffect(() => {
    if (activePaneId && paneMeta[activePaneId]?.bell) setPaneMeta(activePaneId, { bell: false });
  }, [activePaneId, paneMeta, setPaneMeta]);

  // ── phone navigation (the URL's ?s= is the open session; history gives Back) ──
  const pushed = useRef(false);
  const phoneOpen = useCallback((sessionId: string) => {
    window.history.pushState(null, '', stripHref(sessionId));
    pushed.current = true;
  }, []);
  const phoneBack = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      window.history.replaceState(null, '', workspaceHref);
    }
  }, [workspaceHref]);

  // ── layout actions ─────────────────────────────────────────────────────────
  const desktopRef = useRef(isDesktop);
  useEffect(() => {
    desktopRef.current = isDesktop;
  }, [isDesktop]);

  const dispatch = useCallback((action: LayoutAction) => sync.dispatch(action), [sync]);

  const follow = useCallback(
    (sessionId: string) => {
      if (!desktopRef.current) {
        phoneOpen(sessionId);
        return;
      }
      const next = sync.dispatch({ type: 'follow', sessionId, tabId: newId(), paneId: newId() });
      const leaf = activeLeaf(next)?.leaf;
      if (leaf?.sessionId === sessionId) requestFocus(leaf.id);
      else setNotice(t('notice.tabLimit'));
    },
    [sync, phoneOpen, requestFocus, t],
  );

  // A session that already has a tab (alone or in a split) is switched to, never opened twice.
  const openInNewTab = useCallback(
    (sessionId: string | null) => {
      const before = sync.getSnapshot();
      const shown = sessionId !== null && findSession(before, sessionId) !== null;
      if (!shown && !canOpenTab(before)) {
        setNotice(t('notice.tabLimit'));
        return;
      }
      const tabId = newId();
      const paneId = newId();
      const next = sync.dispatch(
        sessionId === null
          ? { type: 'openTab', tabId, paneId, sessionId }
          : { type: 'showInTab', sessionId, tabId, paneId },
      );
      const leaf = activeLeaf(next)?.leaf;
      if (leaf) requestFocus(leaf.id);
    },
    [sync, requestFocus, t],
  );

  const splitActive = useCallback(
    (direction: 'row' | 'column', sessionId: string | null) => {
      const before = sync.getSnapshot();
      const target = activeLeaf(before);
      if (!target) {
        openInNewTab(sessionId);
        return;
      }
      const paneId = newId();
      const next = canSplit(before, target.tab.id, target.leaf.id)
        ? sync.dispatch({
            type: 'split',
            tabId: target.tab.id,
            paneId: target.leaf.id,
            direction,
            splitId: newId(),
            newPaneId: paneId,
            sessionId,
          })
        : before;
      if (next === before) setNotice(t('notice.paneLimit'));
      else requestFocus(paneId);
    },
    [sync, openInNewTab, requestFocus, t],
  );

  const closePane = useCallback(
    ({ tabId, paneId }: PanePlace) => {
      if (tabId === null) {
        phoneBack();
        return;
      }
      const wasActive = activeLeaf(sync.getSnapshot())?.leaf.id === paneId;
      const next = sync.dispatch({ type: 'closePane', tabId, paneId });
      const leaf = activeLeaf(next)?.leaf;
      if (wasActive && leaf) requestFocus(leaf.id);
    },
    [sync, phoneBack, requestFocus],
  );

  const bindPane = useCallback(
    ({ tabId, paneId }: PanePlace, sessionId: string) => {
      if (tabId === null) return;
      sync.dispatch({ type: 'bind', tabId, paneId, sessionId });
      sync.dispatch({ type: 'focusPane', tabId, paneId });
      requestFocus(paneId);
    },
    [sync, requestFocus],
  );

  const onPaneFocus = useCallback(
    ({ tabId, paneId }: PanePlace) => {
      if (tabId !== null) sync.dispatch({ type: 'focusPane', tabId, paneId });
    },
    [sync],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      const next = sync.dispatch({ type: 'activateTab', tabId });
      const leaf = activeLeaf(next)?.leaf;
      if (leaf) requestFocus(leaf.id);
    },
    [sync, requestFocus],
  );

  const sessionAction = useCallback(
    async (kind: SessionActionKind, sessionId: string): Promise<SessionActionResult> => {
      try {
        if (kind === 'retry') return await retrySession(sessionId);
        if (kind === 'reopen') return await reopenSession(sessionId);
        return await terminateSession(sessionId);
      } catch {
        return { ok: false, code: 'UNAVAILABLE', message: t('notice.actionFailed') };
      }
    },
    [t],
  );

  // ── palette ────────────────────────────────────────────────────────────────
  const [palette, setPalette] = useState<{ target: PanePlace | null } | null>(null);
  const openPalette = useCallback((target?: PanePlace) => {
    setPalette({ target: target ?? null });
  }, []);
  const closePalette = useCallback(() => setPalette(null), []);
  const firstRun = hostCount === 0;
  useEffect(() => {
    const onRequest = () => openPalette();
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      openPalette();
    };
    window.addEventListener(NEW_SESSION_EVENT, onRequest);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(NEW_SESSION_EVENT, onRequest);
      window.removeEventListener('keydown', onKey);
    };
  }, [openPalette]);

  const paneAreaRef = useRef<HTMLDivElement>(null);
  const createViewport = (target: PanePlace | null) => {
    const handle =
      (target && handles.current.get(target.paneId)) ??
      (desktopRef.current
        ? activePaneId
          ? handles.current.get(activePaneId)
          : undefined
        : handles.current.get(PHONE_PANE));
    const measured = handle?.viewport();
    if (measured) return clampCreateViewport(measured);
    const area = paneAreaRef.current?.getBoundingClientRect();
    return estimateViewport(
      area?.width || window.innerWidth,
      area?.height || window.innerHeight,
      preferences.fontSize,
    );
  };

  const paletteSessions: PaletteSession[] = useMemo(
    () =>
      bay.sessions
        .filter((s) => s.status !== 'ended')
        .map((s) => ({
          id: s.id,
          label: s.label,
          target: `${s.user}@${s.host}`,
          status: s.status,
        })),
    [bay.sessions],
  );

  // A session the layout already shows is switched to (follow), not bound into a second pane.
  const jumpTo = (sessionId: string, target: PanePlace | null) => {
    setPalette(null);
    if (target && desktopRef.current && !findSession(sync.getSnapshot(), sessionId)) {
      bindPane(target, sessionId);
    } else {
      follow(sessionId);
    }
  };

  const createFromProfile = async (profileId: string): Promise<SessionActionResult> => {
    const target = palette?.target ?? null;
    let result: SessionActionResult;
    try {
      result = await createSession({ profileId, viewport: createViewport(target) });
    } catch {
      return { ok: false, code: 'UNAVAILABLE', message: t('notice.actionFailed') };
    }
    if (result.ok && result.sessionId) jumpTo(result.sessionId, target);
    return result;
  };

  // ── deep link on desktop: /workspace?s=<id> opens (or focuses) that session once ──
  const handledUrl = useRef(false);
  useEffect(() => {
    if (!hydrated || !isDesktop || handledUrl.current) return;
    handledUrl.current = true;
    if (urlSession && serverBay.sessions.some((s) => s.id === urlSession)) {
      follow(urlSession);
      window.history.replaceState(null, '', workspaceHref);
    }
  }, [hydrated, isDesktop, urlSession, serverBay.sessions, follow, workspaceHref]);

  // ── phone key bar ──────────────────────────────────────────────────────────
  const [ctrl, setCtrl] = useState(false);
  const ctrlArmed = useRef(false);
  const changeCtrl = useCallback((armed: boolean) => {
    ctrlArmed.current = armed;
    setCtrl(armed);
  }, []);
  const consumeCtrl = useCallback(() => changeCtrl(false), [changeCtrl]);
  const [phoneNotice, setPhoneNotice] = useState<string | null>(null);
  const onKey = (key: TerminalKey, modifiers: { ctrl: boolean }) => {
    const handle = handles.current.get(PHONE_PANE);
    if (!handle) return;
    handle.channel.input(
      encodeKey(key, {
        ctrl: modifiers.ctrl,
        applicationCursor: handle.terminal.modes.applicationCursorKeysMode,
      }),
    );
  };
  const onPaste = () => {
    const handle = handles.current.get(PHONE_PANE);
    if (!handle) return;
    if (!navigator.clipboard?.readText) {
      setPhoneNotice(t('pane.clipboardDenied'));
      return;
    }
    // Through xterm, so bracketed paste mode is honoured.
    navigator.clipboard.readText().then(
      (text) => {
        if (text) handle.terminal.paste(text);
      },
      () => setPhoneNotice(t('pane.clipboardDenied')),
    );
  };

  // ── context ────────────────────────────────────────────────────────────────
  const hostHref = useCallback(
    (hostId: string) => `${hostsHref}/${encodeURIComponent(hostId)}`,
    [hostsHref],
  );
  const context: WorkspaceContextValue = useMemo(
    () => ({
      connection,
      connectionState,
      sessions,
      preferences,
      appearance,
      isDesktop,
      focusRequest,
      ctrlArmed,
      consumeCtrl,
      registerPane,
      onPaneFocus,
      setPaneMeta,
      closePane,
      bindPane,
      openPalette,
      sessionAction,
      hostHref,
    }),
    [
      connection,
      connectionState,
      sessions,
      preferences,
      appearance,
      isDesktop,
      focusRequest,
      consumeCtrl,
      registerPane,
      onPaneFocus,
      setPaneMeta,
      closePane,
      bindPane,
      openPalette,
      sessionAction,
      hostHref,
    ],
  );

  // ── view ───────────────────────────────────────────────────────────────────
  const phoneSessionId = urlSession;
  const phoneView = phoneSessionId ? 'pane' : 'bay';
  const followedId = isDesktop ? (current?.leaf.sessionId ?? null) : phoneSessionId;
  const phoneSession = phoneSessionId
    ? (sessions.get(phoneSessionId) ?? bay.sessions.find((s) => s.id === phoneSessionId))
    : undefined;
  const phoneStatus = phoneSession?.status;
  const phoneLabel = phoneSession?.label ?? t('pane.loading');
  const phoneProtectionLabel = t(`protection.${phoneSession?.protection ?? 'pending'}`);
  const viewportHeight = useVisualViewportHeight(!isDesktop && phoneView === 'pane');
  const tab = current?.tab ?? null;
  const paneCount = tab ? leaves(tab.root).length : 0;

  let desktopPanes: ReactNode;
  if (tab) {
    desktopPanes = hydrated ? (
      <PaneTree
        key={tab.id}
        tab={tab}
        paneCount={paneCount}
        paneMeta={paneMeta}
        dispatch={dispatch}
      />
    ) : (
      <div className="h-full w-full rounded-[3px] bg-pane" />
    );
  } else {
    desktopPanes = (
      <div className="surface-pane flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto rounded-[3px] bg-pane p-4">
        {firstRun ? (
          <FirstRunPanel hostsHref={hostsHref} />
        ) : (
          <PickSessionPanel hasSessions={bay.sessions.length > 0} />
        )}
      </div>
    );
  }

  const menuActions = (session: BaySession) => ({
    openInTab: () => openInNewTab(session.id),
    split: (direction: 'row' | 'column') => splitActive(direction, session.id),
    run: (kind: SessionActionKind) => sessionAction(kind, session.id),
  });

  return (
    <WorkspaceProvider value={context}>
      <div
        className="flex h-dvh overflow-hidden bg-board-0 text-board-ink"
        style={viewportHeight ? { height: viewportHeight } : undefined}
      >
        <SkipLink label={tc('skipToContent')} target={followedId ? 'main' : 'bay-lanes'} />

        <aside
          aria-label={t('bay.label')}
          className={cx(
            'surface-board flex w-full min-w-0 flex-col bg-board-1 md:w-(--bay-width) md:shrink-0',
            phoneView === 'pane' && 'max-md:hidden',
          )}
        >
          <div className="flex flex-col gap-3 px-3 pt-4 pb-3">
            <div className="flex h-7 items-center px-1">
              <Wordmark />
            </div>
            <NewSessionButton disabled={hostCount === 0} />
          </div>

          <div id="bay-lanes" className="min-h-0 flex-1 overflow-y-auto ps-3 pe-4 pt-1 pb-4">
            {hostCount === 0 ? (
              <>
                <p className="px-1 text-board-ink-muted text-sm max-md:hidden">
                  {t('bay.noHosts')}
                </p>
                <FirstRunPanel hostsHref={hostsHref} className="md:hidden" />
              </>
            ) : bay.sessions.length === 0 ? (
              <div className="flex flex-col gap-1 px-1">
                <p className="font-semibold text-board-ink text-sm">{t('bay.emptyTitle')}</p>
                <p className="text-board-ink-muted text-sm">{t('bay.emptyBody')}</p>
              </div>
            ) : (
              <Bay
                data={bay}
                followedId={followedId}
                renderedAt={renderedAt}
                stripHref={stripHref}
                onFollow={follow}
                menuActions={menuActions}
                desktop={isDesktop}
              />
            )}
          </div>

          <footer className="flex flex-col gap-2 border-board-rule border-t px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="flex items-start justify-between gap-2">
              <AccountMenu username={username} isAdmin={isAdmin} locale={locale} />
              <SignOutButton label={tc('signOut')} iconOnly />
            </div>
            {/* On a phone the picker folds into the account disclosure to keep the switcher tall. */}
            <LocaleSwitcher locale={locale} hideLabel fill className="max-md:hidden" />
          </footer>
        </aside>

        <main
          id="main"
          aria-label={t('pane.label')}
          className={cx(
            'flex min-w-0 flex-1 flex-col bg-board-2',
            phoneView === 'bay' && 'max-md:hidden',
          )}
        >
          {phoneSessionId ? (
            <div className="flex h-12 shrink-0 items-center gap-2 ps-1 pe-3 md:hidden">
              <Button
                variant="quiet"
                size="sm"
                icon={<ChevronLeftIcon size={18} />}
                onClick={phoneBack}
              >
                {t('phone.back')}
              </Button>
              <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
                <span className="truncate font-semibold font-strip text-strip">{phoneLabel}</span>
                {phoneSession ? (
                  <span
                    className="flex shrink-0 items-center text-board-ink"
                    title={phoneProtectionLabel}
                  >
                    <ProtectionMark protection={phoneSession.protection} />
                    <span className="sr-only">{phoneProtectionLabel}</span>
                  </span>
                ) : null}
                {phoneStatus ? (
                  <StatusChip status={phoneStatus} label={t(`status.${phoneStatus}`)} />
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="max-md:hidden">
            <TabBar
              layout={layout}
              sessions={sessions}
              paneMeta={paneMeta}
              onSelect={selectTab}
              onClose={(tabId) => dispatch({ type: 'closeTab', tabId })}
              onSplit={(direction) => splitActive(direction, null)}
              canSplit={current !== null}
              revealKey={focusRequest?.seq ?? 0}
              trailing={<ConnectionChip connection={connection} />}
            />
          </div>

          <ConnectionFailure connection={connection} />
          <ConnectionLimit connection={connection} />
          {notice ? (
            <div className="px-1.5 pb-1.5">
              <Notice tone="warning">{notice}</Notice>
            </div>
          ) : null}

          <div
            ref={paneAreaRef}
            className="relative flex min-h-0 flex-1 flex-col md:px-1.5 md:pb-1.5"
          >
            {isDesktop ? (
              desktopPanes
            ) : phoneSessionId && hydrated ? (
              <div className="relative min-h-0 flex-1 bg-pane">
                <TerminalPane
                  key={phoneSessionId}
                  place={{ tabId: null, paneId: PHONE_PANE }}
                  sessionId={phoneSessionId}
                  active
                  onClose={phoneBack}
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 bg-pane" />
            )}
          </div>

          {!isDesktop && phoneSessionId ? (
            <>
              {phoneNotice ? (
                <div className="px-1.5 pt-1.5">
                  <Notice tone="warning">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span>{phoneNotice}</span>
                      <button
                        type="button"
                        className="font-semibold underline underline-offset-2"
                        onClick={() => setPhoneNotice(null)}
                      >
                        {t('overlay.dismiss')}
                      </button>
                    </span>
                  </Notice>
                </div>
              ) : null}
              <KeyBar ctrl={ctrl} onCtrlChange={changeCtrl} onKey={onKey} onPaste={onPaste} />
            </>
          ) : null}
        </main>
      </div>

      {palette ? (
        <CommandPalette
          sessions={paletteSessions}
          profiles={profiles}
          hostsHref={hostsHref}
          onJump={(sessionId) => jumpTo(sessionId, palette.target)}
          onCreate={createFromProfile}
          onClose={closePalette}
        />
      ) : null}
    </WorkspaceProvider>
  );
}
