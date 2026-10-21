'use client';

import type { WorkspaceLayout } from '@termavox/protocol/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEntry, TermavoxConnection } from '../../lib/terminal/index.ts';
import { bellNotification, bellPane, lookingAt, shouldNotify } from '../../lib/workspace/notify.ts';
import { cleanTitle, windowTitle } from '../../lib/workspace/title.ts';
import type { PaneBell, PaneMeta } from './workspace-context.tsx';

/**
 * The terminal bell, in one place (the workspace shell calls this once). Two signals reach it:
 * - `terminal.bell` from a mounted pane (`ringBell`): marks the pane (its tab shows the attention
 *   bell) unless the user is looking at it, and, on the desktop, a bell in the active pane while
 *   the window is unfocused or hidden counts as unseen until the window regains focus (the window
 *   title's marker).
 * - `session.bell` from the daemon, for a session with desktop notifications on, attached here
 *   or not (only the active tab's panes are mounted): on the desktop, when a pane of any tab
 *   shows that session (`bellPane`) and the user is not looking at it, marks that pane and shows
 *   a desktop notification (`shouldNotify`). Clicking it brings the window and the session to the
 *   front; looking at that session's pane closes it. A session in no tab does nothing here.
 */
export function useBellAlerts({
  connection,
  isDesktop,
  layout,
  activeSessionId,
  sessions,
  paneMeta,
  setPaneMeta,
  follow,
  lang,
  bellBody,
}: {
  connection: TermavoxConnection;
  isDesktop: boolean;
  layout: WorkspaceLayout;
  /** The session of the active pane of the tab in front (desktop), if any. */
  activeSessionId: string | null;
  sessions: ReadonlyMap<string, SessionEntry>;
  paneMeta: Readonly<Record<string, PaneMeta>>;
  setPaneMeta(paneId: string, patch: Partial<PaneMeta>): void;
  /** Brings a session to the front exactly as its row does (the shell's follow). */
  follow(sessionId: string): void;
  lang: string;
  /** The notification's text when the pane has no terminal title (localized). */
  bellBody: string;
}): { ringBell(bell: PaneBell): void; activeBellUnseen: boolean } {
  const [activeBellUnseen, setActiveBellUnseen] = useState(false);
  // Read when a bell rings or a notification is clicked, never in render.
  const latest = useRef({ isDesktop, layout, sessions, paneMeta, follow, lang, bellBody });
  useEffect(() => {
    latest.current = { isDesktop, layout, sessions, paneMeta, follow, lang, bellBody };
  });
  const lastShown = useRef(new Map<string, number>());
  const open = useRef(new Map<string, Notification>());

  const closeFor = useCallback((sessionId: string) => {
    const shown = open.current.get(sessionId);
    if (!shown) return;
    open.current.delete(sessionId);
    shown.close();
  }, []);

  // `terminal.bell` of a mounted pane: the tab mark and the window title's marker only.
  const ringBell = useCallback(
    ({ paneId, active }: PaneBell) => {
      const focused = document.hasFocus();
      const hidden = document.visibilityState === 'hidden';
      if (!lookingAt({ active, focused, hidden })) setPaneMeta(paneId, { bell: true });
      if (latest.current.isDesktop && active && (!focused || hidden)) setActiveBellUnseen(true);
    },
    [setPaneMeta],
  );

  // `session.bell`: wherever the session is shown, in any tab, and the desktop notification.
  useEffect(
    () =>
      connection.subscribeBells(({ sessionId, title: remoteTitle }) => {
        const { isDesktop: desktop, layout: current, sessions: entries } = latest.current;
        if (!desktop) return;
        const pane = bellPane(current, sessionId);
        if (!pane) return;
        const focused = document.hasFocus();
        const hidden = document.visibilityState === 'hidden';
        if (lookingAt({ active: pane.active, focused, hidden })) return;
        setPaneMeta(pane.paneId, { bell: true });

        const supported = 'Notification' in window;
        const entry = entries.get(sessionId);
        const now = Date.now();
        const notify = shouldNotify({
          notify: entry?.notify ?? false,
          desktop,
          supported,
          permission: supported ? Notification.permission : null,
          active: pane.active,
          focused,
          hidden,
          now,
          lastShownAt: lastShown.current.get(sessionId) ?? null,
        });
        if (!notify || !entry) return;
        lastShown.current.set(sessionId, now);
        const { title, options } = bellNotification({
          sessionId,
          label: entry.label,
          // The daemon's title is current; the pane's may date from when its tab was last in view.
          title:
            (remoteTitle === null ? null : cleanTitle(remoteTitle)) ??
            latest.current.paneMeta[pane.paneId]?.title ??
            null,
          lang: latest.current.lang,
          fallbackBody: latest.current.bellBody,
        });
        let shown: Notification;
        try {
          shown = new Notification(title, options);
        } catch {
          // Some browsers only show notifications from a service worker: nothing to show here.
          return;
        }
        open.current.set(sessionId, shown);
        shown.onclick = () => {
          window.focus();
          latest.current.follow(sessionId);
          closeFor(sessionId);
        };
        shown.onclose = () => {
          if (open.current.get(sessionId) === shown) open.current.delete(sessionId);
        };
      }),
    [connection, setPaneMeta, closeFor],
  );

  // Looking at a session's pane (it became active, or the window came back with it active) closes
  // its notification; the window regaining focus also clears the unseen bell of the active pane.
  useEffect(() => {
    const check = () => {
      if (!document.hasFocus() || document.visibilityState === 'hidden') return;
      setActiveBellUnseen(false);
      if (activeSessionId) closeFor(activeSessionId);
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [activeSessionId, closeFor]);

  // Leaving the workspace closes what it showed: nothing left could bring a session forward.
  useEffect(() => {
    const shown = open.current;
    return () => {
      for (const notification of shown.values()) notification.close();
      shown.clear();
    };
  }, []);

  return { ringBell, activeBellUnseen };
}

/**
 * The browser window's title follows the active tab on the desktop (`windowTitle`): its label and
 * terminal title, with the bell marker while a bell is unseen. With no tab open, and on a phone,
 * the page's own title; it comes back when the workspace unmounts.
 */
export function useWindowTitle(
  isDesktop: boolean,
  tab: { label: string; title: string | null } | null,
  unseenBell: boolean,
): void {
  const original = useRef<string | null>(null);
  const applied = useRef<string | null>(null);
  useEffect(() => {
    original.current = document.title;
    return () => {
      // Only while the title is still ours: leaving for another page, Next has already written
      // that page's title by the time this runs.
      if (original.current !== null && document.title === applied.current) {
        document.title = original.current;
      }
      original.current = null;
      applied.current = null;
    };
  }, []);
  const label = tab?.label ?? null;
  const title = tab?.title ?? null;
  useEffect(() => {
    const fallback = original.current;
    if (fallback === null) return;
    const next =
      isDesktop && label !== null ? windowTitle({ label, title }, unseenBell, fallback) : fallback;
    document.title = next;
    applied.current = next;
  }, [isDesktop, label, title, unseenBell]);
}
