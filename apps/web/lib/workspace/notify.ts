import type { WorkspaceLayout } from '@termavox/protocol/client';
import { activeLeaf, findSession } from './tree.ts';

/**
 * Desktop notifications for the terminal bell: where a bell lands, the decision and the
 * notification's content, kept pure so they can be tested without a browser. The workspace shell
 * calls them when the daemon relays a session's bell (`session.bell`,
 * components/workspace/use-bell-alerts.ts).
 */

/**
 * Where a session's bell lands in this browser's layout: the pane that shows the session, in any
 * tab (the active tab first, as `findSession` looks), and whether that pane is the active pane of
 * the active tab. Null when no tab shows the session: its bell does nothing here.
 */
export function bellPane(
  layout: WorkspaceLayout,
  sessionId: string,
): { paneId: string; active: boolean } | null {
  const found = findSession(layout, sessionId);
  if (!found) return null;
  return { paneId: found.paneId, active: activeLeaf(layout)?.leaf.id === found.paneId };
}

/** At most one notification per session in a browser tab: a remote ringing on repeat never spams. */
export const NOTIFY_THROTTLE_MS = 5_000;

/** The browser shows this as the notification's image (the phone home-screen icon, 180 px). */
export const NOTIFY_ICON = '/apple-icon.png';

/** What is known when a bell rings, read at that moment. */
export interface BellFacts {
  /** The session's stored flag (the owner turned its notifications on). */
  notify: boolean;
  /** The desktop workspace (the phone never notifies). */
  desktop: boolean;
  /** The browser has the Notification API. */
  supported: boolean;
  /** `Notification.permission`, null without the API. */
  permission: NotificationPermission | null;
  /** The pane that rang is the active pane of the tab in front. */
  active: boolean;
  /** `document.hasFocus()`. */
  focused: boolean;
  /** `document.visibilityState === 'hidden'` (minimized, or another browser tab in front). */
  hidden: boolean;
  /** Now, epoch ms. */
  now: number;
  /** When this session last showed a notification in this browser tab; null if never. */
  lastShownAt: number | null;
}

/** The user is looking at the pane: it is the active one, in a focused, visible window. */
export function lookingAt(facts: Pick<BellFacts, 'active' | 'focused' | 'hidden'>): boolean {
  return facts.active && facts.focused && !facts.hidden;
}

/**
 * A bell notifies when the session has notifications on, on the desktop, with the API present and
 * permission granted, while the user is not looking at its pane, and at most once per session in
 * NOTIFY_THROTTLE_MS.
 */
export function shouldNotify(facts: BellFacts): boolean {
  if (!facts.notify || !facts.desktop || !facts.supported) return false;
  if (facts.permission !== 'granted' || lookingAt(facts)) return false;
  return facts.lastShownAt === null || facts.now - facts.lastShownAt >= NOTIFY_THROTTLE_MS;
}

/** The tag of a session's notification: a newer one replaces it instead of piling up. */
export function notifyTag(sessionId: string): string {
  return `termavox-session:${sessionId}`;
}

/**
 * The notification for a session's bell. Never terminal output: the session's label as the title,
 * and as the body the pane's terminal title (already cleaned by `cleanTitle`) or, without one,
 * `fallbackBody` (localized).
 */
export function bellNotification(input: {
  sessionId: string;
  label: string;
  title: string | null;
  lang: string;
  fallbackBody: string;
}): { title: string; options: NotificationOptions } {
  return {
    title: input.label,
    options: {
      body: input.title ?? input.fallbackBody,
      tag: notifyTag(input.sessionId),
      icon: NOTIFY_ICON,
      lang: input.lang,
    },
  };
}
