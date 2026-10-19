'use client';

import { CloseCode } from '@termdock/protocol/client';
import Link from 'next/link';
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
  removeSession,
  reopenSession,
  retrySession,
  stopSession,
  terminateSession,
} from '../../lib/actions/sessions.ts';
import { withReturnPath } from '../../lib/manage/return-to.ts';
import type { TerminalPreferences } from '../../lib/preferences/terminal.ts';
import { ROUTES } from '../../lib/routes.ts';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import { sessionLabels, toBayData } from '../../lib/sessions/live.ts';
import { sessionTarget } from '../../lib/sessions/target.ts';
import type { BayData, BaySession } from '../../lib/sessions/types.ts';
import { pasteText, TermdockConnection } from '../../lib/terminal/index.ts';
import { useConnectionState } from '../../lib/terminal/react.ts';
import { encodeKey, type TerminalKey } from '../../lib/workspace/keys.ts';
import {
  fetchLayoutTransport,
  LayoutSync,
  type StoredLayout,
} from '../../lib/workspace/layout-sync.ts';
import { resolveOpenParam } from '../../lib/workspace/open-param.ts';
import {
  activeLeaf,
  canOpenTab,
  canSplit,
  findSession,
  type LayoutAction,
  leaves,
  newId,
} from '../../lib/workspace/tree.ts';
import { ChevronLeftIcon, RetryIcon } from '../icons/index.tsx';
import { SkipLink } from '../skip-link.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Notice } from '../ui/notice.tsx';
import { ProtectionMark } from '../ui/session-row.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { StatusChip } from '../ui/status-chip.tsx';
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
import { NEW_SESSION_EVENT } from './new-session-button.tsx';
import { CommandPalette, type PaletteServer, type PaletteSession } from './palette.tsx';
import { PaneTree } from './pane-tree.tsx';
import { RenameDialog, type RenameTarget } from './rename-dialog.tsx';
import { SESSION_LIST_ID, Sidebar } from './sidebar.tsx';
import { useSidebarMode } from './sidebar-preference.ts';
import { TabBar } from './tab-bar.tsx';
import { isPaletteShortcut, TerminalPane } from './terminal-pane.tsx';
import { withViewTransition } from './transitions.ts';
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
  serverCount: number;
  renderedAt: number;
  username: string;
  locale: Locale;
  workspaceHref: string;
  serversHref: string;
  /** The Add server form, carrying the way back to the workspace (plan D-27). */
  addServerHref: string;
  loginHref: string;
  /** Shows the Admin entry in the account menu. */
  isAdmin?: boolean;
  /** The saved layout and its version (first paint; the client never refetches on load). */
  initialLayout: StoredLayout;
  servers: PaletteServer[];
  preferences: TerminalPreferences;
}

/** The tab's own WebSocket state, on the trailing edge of the tab bar and the phone header. */
function ConnectionChip({ connection }: { connection: TermdockConnection }) {
  const t = useTranslations('workspace.connection');
  const state = useConnectionState(connection);
  const now = useNow(1_000, state.status === 'reconnecting');
  if (state.shuttingDown && state.status !== 'open') {
    return (
      <span role="status" className="flex items-center gap-1.5 text-ink-muted text-xs">
        <Spinner size={13} />
        {t('restarting')}
      </span>
    );
  }
  if (state.status !== 'reconnecting') return null;
  const seconds = state.retryAt ? Math.max(0, Math.ceil((state.retryAt - now) / 1_000)) : 0;
  return (
    <span role="status" className="flex items-center gap-2 text-ink-muted text-xs">
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
    <div className="px-2 pb-2 max-md:pt-2">
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
    <div className="px-2 pb-2 max-md:pt-2">
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

/** The anchor of the "Sessions on this server" card on a server page (plan D-30). */
const REMOTE_SESSIONS_ANCHOR = 'remote-sessions';

/**
 * Plan D-30: a session's connection found Termdock sessions on its server that this installation
 * does not run. One dismissible notice per server, linking to that server's page (and back here);
 * a dismissed server stays quiet while the tab lives.
 */
function RemoteSessionsNotices({
  connection,
  serverHref,
}: {
  connection: TermdockConnection;
  serverHref: (serverId: string) => string;
}) {
  const t = useTranslations('workspace');
  const { remoteSessions } = useConnectionState(connection);
  if (remoteSessions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-2 pb-2 max-md:pt-2">
      {remoteSessions.map((notice) => (
        <Notice
          key={notice.serverId}
          tone="info"
          title={t('remoteSessions.title', { server: notice.serverName })}
        >
          <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span>
              {t('remoteSessions.body', { count: notice.count })}{' '}
              <Link
                href={`${withReturnPath(serverHref(notice.serverId), ROUTES.workspace)}#${REMOTE_SESSIONS_ANCHOR}`}
                className="font-semibold underline underline-offset-2"
              >
                {t('remoteSessions.review')}
              </Link>
            </span>
            <button
              type="button"
              className="font-semibold underline underline-offset-2"
              onClick={() => connection.dismissRemoteSessions(notice.serverId)}
            >
              {t('overlay.dismiss')}
            </button>
          </span>
        </Notice>
      ))}
    </div>
  );
}

/**
 * The live workspace: the session sidebar (left), the tab row over the split panes (right), one
 * WebSocket for the whole browser tab. On a phone the sidebar is the switcher and a session
 * opens alone, full screen, with the extra-key bar, without touching the desktop layout. First
 * paint comes from the server (session rows, saved layout); the live store takes over once the
 * session list arrives.
 */
export function WorkspaceShell({
  bay: serverBay,
  serverCount,
  renderedAt,
  username,
  locale,
  workspaceHref,
  serversHref,
  addServerHref,
  loginHref,
  isAdmin = false,
  initialLayout,
  servers,
  preferences,
}: WorkspaceShellProps) {
  const t = useTranslations('workspace');
  const tc = useTranslations('common');
  const isDesktop = useIsDesktop();
  const hydrated = useHydrated();
  const searchParams = useSearchParams();
  const urlSession = searchParams.get('s');
  const openParam = resolveOpenParam(
    searchParams,
    serverBay.sessions.map((s) => s.id),
  );

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
  // Tabs and pane captions read the first paint's summaries until the live list arrives.
  const labels = useMemo(
    () => sessionLabels(sessions, connectionState.sessionsLoaded, serverBay.sessions),
    [sessions, connectionState.sessionsLoaded, serverBay.sessions],
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

  // Following moves the reading light to the new row inside a view transition (signature move);
  // the deep link on load applies it directly.
  const follow = useCallback(
    (sessionId: string, animate = true) => {
      if (!desktopRef.current) {
        phoneOpen(sessionId);
        return;
      }
      // Everything that reads the new layout runs inside the callback: a view transition
      // applies it asynchronously, after the old state is captured.
      const apply = () => {
        const next = sync.dispatch({ type: 'follow', sessionId, tabId: newId(), paneId: newId() });
        const leaf = activeLeaf(next)?.leaf;
        if (leaf?.sessionId === sessionId) requestFocus(leaf.id);
        else setNotice(t('notice.tabLimit'));
      };
      if (animate) withViewTransition(apply);
      else apply();
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
        if (kind === 'stop') return await stopSession(sessionId);
        if (kind === 'remove') return await removeSession(sessionId);
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
  const firstRun = serverCount === 0;
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
          target: sessionTarget(s, t('localTarget')),
          status: s.status,
        })),
    [bay.sessions, t],
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

  const createFromServer = async (
    serverId: string,
    label: string,
  ): Promise<SessionActionResult> => {
    const target = palette?.target ?? null;
    let result: SessionActionResult;
    try {
      result = await createSession({
        serverId,
        ...(label ? { label } : {}),
        viewport: createViewport(target),
      });
    } catch {
      return { ok: false, code: 'UNAVAILABLE', message: t('notice.actionFailed') };
    }
    if (result.ok && result.sessionId) jumpTo(result.sessionId, target);
    return result;
  };

  // ── deep links, handled once after hydration ──────────────────────────────
  // /workspace?s=<id> (desktop) opens or focuses that session; /workspace?open=<id> (plan D-27,
  // where the Add server form sends the browser) shows it exactly as clicking its row does, on
  // a phone by becoming ?s=<id>. Either way the URL is cleaned in place, with no history entry.
  const handledUrl = useRef(false);
  useEffect(() => {
    if (!hydrated || handledUrl.current) return;
    if (openParam.present) {
      handledUrl.current = true;
      if (!openParam.sessionId) {
        window.history.replaceState(null, '', workspaceHref);
      } else if (isDesktop) {
        follow(openParam.sessionId, false);
        window.history.replaceState(null, '', workspaceHref);
      } else {
        window.history.replaceState(null, '', stripHref(openParam.sessionId));
      }
      return;
    }
    if (!isDesktop) return;
    handledUrl.current = true;
    if (urlSession && serverBay.sessions.some((s) => s.id === urlSession)) {
      follow(urlSession, false);
      window.history.replaceState(null, '', workspaceHref);
    }
  }, [hydrated, isDesktop, urlSession, openParam, serverBay.sessions, follow, workspaceHref]);

  // ── rename (plan D-28): one dialog for every row, tile and phone-list menu ──
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const closeRename = useCallback(() => setRenameTarget(null), []);

  // ── phone key bar ──────────────────────────────────────────────────────────
  const [ctrl, setCtrl] = useState(false);
  const ctrlArmed = useRef(false);
  const changeCtrl = useCallback((armed: boolean) => {
    ctrlArmed.current = armed;
    setCtrl(armed);
  }, []);
  const consumeCtrl = useCallback(() => changeCtrl(false), [changeCtrl]);
  const [alt, setAlt] = useState(false);
  const altArmed = useRef(false);
  const changeAlt = useCallback((armed: boolean) => {
    altArmed.current = armed;
    setAlt(armed);
  }, []);
  const consumeAlt = useCallback(() => changeAlt(false), [changeAlt]);
  const [phoneNotice, setPhoneNotice] = useState<string | null>(null);
  const onKey = (key: TerminalKey, modifiers: { ctrl: boolean; alt: boolean }) => {
    const handle = handles.current.get(PHONE_PANE);
    if (!handle) return;
    handle.channel.input(
      encodeKey(key, {
        ctrl: modifiers.ctrl,
        alt: modifiers.alt,
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
    // Through xterm, so bracketed paste mode is honoured; sanitized like every paste.
    navigator.clipboard.readText().then(
      (text) => pasteText(handle.terminal, text),
      () => setPhoneNotice(t('pane.clipboardDenied')),
    );
  };

  // ── context ────────────────────────────────────────────────────────────────
  const serverHref = useCallback(
    (serverId: string) => `${serversHref}/${encodeURIComponent(serverId)}`,
    [serversHref],
  );
  const context: WorkspaceContextValue = useMemo(
    () => ({
      connection,
      connectionState,
      sessions,
      labels,
      preferences,
      appearance,
      isDesktop,
      focusRequest,
      ctrlArmed,
      consumeCtrl,
      altArmed,
      consumeAlt,
      registerPane,
      onPaneFocus,
      setPaneMeta,
      closePane,
      bindPane,
      openPalette,
      sessionAction,
      serverHref,
    }),
    [
      connection,
      connectionState,
      sessions,
      labels,
      preferences,
      appearance,
      isDesktop,
      focusRequest,
      consumeCtrl,
      consumeAlt,
      registerPane,
      onPaneFocus,
      setPaneMeta,
      closePane,
      bindPane,
      openPalette,
      sessionAction,
      serverHref,
    ],
  );

  // ── view ───────────────────────────────────────────────────────────────────
  const [sidebarMode, setSidebarMode] = useSidebarMode();
  const rail = isDesktop && sidebarMode === 'rail';
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
      <div className="h-full w-full rounded-row border border-line bg-pane" />
    );
  } else {
    desktopPanes = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto rounded-row border border-line bg-pane p-4">
        {firstRun ? <FirstRunPanel /> : <PickSessionPanel hasSessions={bay.sessions.length > 0} />}
      </div>
    );
  }

  const menuActions = (session: BaySession) => ({
    openInTab: () => openInNewTab(session.id),
    split: (direction: 'row' | 'column') => splitActive(direction, session.id),
    rename: () => setRenameTarget({ sessionId: session.id, label: session.label }),
    run: (kind: SessionActionKind) => sessionAction(kind, session.id),
  });

  return (
    <WorkspaceProvider value={context}>
      <div
        className="ground-glow flex h-dvh overflow-hidden text-ink"
        style={{
          ...(viewportHeight ? { height: viewportHeight } : {}),
          ['--sidebar-current' as string]: rail ? 'var(--rail-width)' : 'var(--sidebar-width)',
        }}
      >
        <SkipLink label={tc('skipToContent')} target={followedId ? 'main' : SESSION_LIST_ID} />

        <Sidebar
          username={username}
          isAdmin={isAdmin}
          locale={locale}
          serverCount={serverCount}
          data={bay}
          followedId={followedId}
          renderedAt={renderedAt}
          sessionHref={stripHref}
          onFollow={follow}
          menuActions={menuActions}
          desktop={isDesktop}
          mode={sidebarMode}
          onModeChange={setSidebarMode}
          hidden={phoneView === 'pane'}
        />

        <main
          id="main"
          aria-label={t('pane.label')}
          className={cx('flex min-w-0 flex-1 flex-col', phoneView === 'bay' && 'max-md:hidden')}
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
                <span className="truncate font-semibold text-ink text-sm">{phoneLabel}</span>
                {phoneSession ? (
                  <span
                    className="flex shrink-0 items-center text-ink"
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
              sessions={labels}
              paneMeta={paneMeta}
              onSelect={selectTab}
              onClose={(tabId) => dispatch({ type: 'closeTab', tabId })}
              onSplit={(direction) => splitActive(direction, null)}
              canSplit={current !== null}
              revealKey={focusRequest?.seq ?? 0}
              trailing={<ConnectionChip connection={connection} />}
              onRenameError={setNotice}
            />
          </div>

          <ConnectionFailure connection={connection} />
          <ConnectionLimit connection={connection} />
          <RemoteSessionsNotices connection={connection} serverHref={serverHref} />
          {notice ? (
            <div className="px-2 pb-2">
              <Notice tone="warning">{notice}</Notice>
            </div>
          ) : null}

          <div ref={paneAreaRef} className="relative flex min-h-0 flex-1 flex-col md:px-2 md:pb-2">
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
                <div className="px-2 pt-2">
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
              <KeyBar
                ctrl={ctrl}
                alt={alt}
                onCtrlChange={changeCtrl}
                onAltChange={changeAlt}
                onKey={onKey}
                onPaste={onPaste}
              />
            </>
          ) : null}
        </main>

        {palette ? (
          <CommandPalette
            sessions={paletteSessions}
            servers={servers}
            addServerHref={addServerHref}
            onJump={(sessionId) => jumpTo(sessionId, palette.target)}
            onCreate={createFromServer}
            onClose={closePalette}
          />
        ) : null}
        <RenameDialog target={renameTarget} onClose={closeRename} />
      </div>
    </WorkspaceProvider>
  );
}
