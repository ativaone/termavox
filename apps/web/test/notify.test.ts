import { EMPTY_LAYOUT, type WorkspaceLayout } from '@termavox/protocol/client';
import { describe, expect, it } from 'vitest';
import {
  type BellFacts,
  bellNotification,
  bellPane,
  lookingAt,
  NOTIFY_THROTTLE_MS,
  notifyTag,
  shouldNotify,
} from '../lib/workspace/notify.ts';
import { type LayoutAction, layoutReducer } from '../lib/workspace/tree.ts';

/** A bell that notifies: notifications on, desktop, granted, rang in a pane in the background. */
const ringing = (facts: Partial<BellFacts> = {}): BellFacts => ({
  notify: true,
  desktop: true,
  supported: true,
  permission: 'granted',
  active: false,
  focused: true,
  hidden: false,
  now: 100_000,
  lastShownAt: null,
  ...facts,
});

describe('desktop notifications for the bell', () => {
  it('notify when the session has them on and the user is not looking at its pane', () => {
    expect(shouldNotify(ringing())).toBe(true);
    // The active pane, but the window is not focused, or it is hidden (minimized, another tab).
    expect(shouldNotify(ringing({ active: true, focused: false }))).toBe(true);
    expect(shouldNotify(ringing({ active: true, hidden: true }))).toBe(true);
    // Looking at it: the active pane of a focused, visible window.
    expect(lookingAt({ active: true, focused: true, hidden: false })).toBe(true);
    expect(shouldNotify(ringing({ active: true }))).toBe(false);
  });

  it('never notify with notifications off, on a phone, without the API or without permission', () => {
    expect(shouldNotify(ringing({ notify: false }))).toBe(false);
    expect(shouldNotify(ringing({ desktop: false }))).toBe(false);
    expect(shouldNotify(ringing({ supported: false, permission: null }))).toBe(false);
    expect(shouldNotify(ringing({ permission: 'default' }))).toBe(false);
    expect(shouldNotify(ringing({ permission: 'denied' }))).toBe(false);
  });

  it('notify at most once per session every 5 seconds', () => {
    expect(NOTIFY_THROTTLE_MS).toBe(5_000);
    const now = 100_000;
    expect(shouldNotify(ringing({ now, lastShownAt: now - 1 }))).toBe(false);
    expect(shouldNotify(ringing({ now, lastShownAt: now - NOTIFY_THROTTLE_MS + 1 }))).toBe(false);
    expect(shouldNotify(ringing({ now, lastShownAt: now - NOTIFY_THROTTLE_MS }))).toBe(true);
    expect(shouldNotify(ringing({ now, lastShownAt: now - 60_000 }))).toBe(true);
  });

  it('show the label and the cleaned terminal title, never output, tagged per session', () => {
    expect(
      bellNotification({
        sessionId: 's-1',
        label: 'build box',
        title: 'claude — waiting for permission',
        lang: 'pt-BR',
        fallbackBody: 'O terminal tocou o sino.',
      }),
    ).toEqual({
      title: 'build box',
      options: {
        body: 'claude — waiting for permission',
        tag: 'termavox-session:s-1',
        icon: '/apple-icon.png',
        lang: 'pt-BR',
      },
    });
    // Without a terminal title: the localized sentence.
    const plain = bellNotification({
      sessionId: 's-2',
      label: 'db',
      title: null,
      lang: 'en',
      fallbackBody: 'The terminal rang its bell.',
    });
    expect(plain.options).toMatchObject({ body: 'The terminal rang its bell.', lang: 'en' });
    // One tag per session: a newer notification replaces the older one.
    expect(notifyTag('s-2')).toBe(plain.options.tag);
    expect(notifyTag('s-1')).not.toBe(notifyTag('s-2'));
  });
});

describe('where a relayed bell lands (session.bell)', () => {
  const apply = (actions: LayoutAction[], from: WorkspaceLayout = EMPTY_LAYOUT) =>
    actions.reduce(layoutReducer, from);
  // Tab t1: s1 (p1) beside s2 (p2, focused); tab t2: s3 (p3), the tab in front.
  const layout = apply([
    { type: 'openTab', tabId: 't1', paneId: 'p1', sessionId: 's1' },
    {
      type: 'split',
      tabId: 't1',
      paneId: 'p1',
      direction: 'row',
      splitId: 'a',
      newPaneId: 'p2',
      sessionId: 's2',
    },
    { type: 'openTab', tabId: 't2', paneId: 'p3', sessionId: 's3' },
  ]);

  it('finds the pane in any tab; only the focused pane of the tab in front is active', () => {
    expect(bellPane(layout, 's3')).toEqual({ paneId: 'p3', active: true });
    // A background tab: not mounted here, so only the relayed bell reaches it.
    expect(bellPane(layout, 's1')).toEqual({ paneId: 'p1', active: false });
    expect(bellPane(layout, 's2')).toEqual({ paneId: 'p2', active: false });

    const front = apply([{ type: 'activateTab', tabId: 't1' }], layout);
    expect(bellPane(front, 's2')).toEqual({ paneId: 'p2', active: true });
    expect(bellPane(front, 's1')).toEqual({ paneId: 'p1', active: false }); // the other pane
    expect(bellPane(front, 's3')).toEqual({ paneId: 'p3', active: false });
  });

  it('is nowhere for a session no tab shows, or with no tab open', () => {
    expect(bellPane(layout, 'elsewhere')).toBeNull();
    expect(bellPane(EMPTY_LAYOUT, 's1')).toBeNull();
  });
});
