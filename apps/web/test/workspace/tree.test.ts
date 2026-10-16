import { EMPTY_LAYOUT, type PaneNode, WorkspaceLayout } from '@termdock/protocol/client';
import { describe, expect, it } from 'vitest';
import {
  activeLeaf,
  type LayoutAction,
  layoutReducer,
  leaves,
  MAX_PANES_PER_TAB,
  MAX_SPLIT_CHILDREN,
  MAX_TABS,
  normalizeLayout,
  resizeSizes,
} from '../../lib/workspace/tree.ts';

const apply = (actions: LayoutAction[], from: WorkspaceLayout = EMPTY_LAYOUT): WorkspaceLayout =>
  actions.reduce(layoutReducer, from);

/** One tab `t1` holding pane `p1` bound to session `s1`. */
const single = apply([{ type: 'openTab', tabId: 't1', paneId: 'p1', sessionId: 's1' }]);

function shape(node: PaneNode): unknown {
  return node.type === 'leaf'
    ? node.id
    : { [node.direction]: node.children.map(shape), sizes: node.sizes };
}

function rootOf(layout: WorkspaceLayout, tabId = 't1'): PaneNode {
  return layout.tabs.find((t) => t.id === tabId)!.root;
}

describe('workspace layout reducer', () => {
  it('opens tabs after the active one and activates them', () => {
    const layout = apply(
      [
        { type: 'openTab', tabId: 't2', paneId: 'p2', sessionId: 's2' },
        { type: 'activateTab', tabId: 't1' },
        { type: 'openTab', tabId: 't3', paneId: 'p3', sessionId: null },
      ],
      single,
    );
    expect(layout.tabs.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(layout.activeTabId).toBe('t3');
    expect(WorkspaceLayout.safeParse(layout).success).toBe(true);
  });

  it('splits a pane: a new split, then a sibling in the same direction, focusing the new pane', () => {
    const once = layoutReducer(single, {
      type: 'split',
      tabId: 't1',
      paneId: 'p1',
      direction: 'row',
      splitId: 'a',
      newPaneId: 'p2',
      sessionId: null,
    });
    expect(shape(rootOf(once))).toEqual({ row: ['p1', 'p2'], sizes: [50, 50] });
    expect(once.tabs[0]!.activePaneId).toBe('p2');

    const twice = layoutReducer(once, {
      type: 'split',
      tabId: 't1',
      paneId: 'p2',
      direction: 'row',
      splitId: 'b',
      newPaneId: 'p3',
      sessionId: 's3',
    });
    expect(shape(rootOf(twice))).toEqual({ row: ['p1', 'p2', 'p3'], sizes: [50, 25, 25] });

    const down = layoutReducer(twice, {
      type: 'split',
      tabId: 't1',
      paneId: 'p1',
      direction: 'column',
      splitId: 'c',
      newPaneId: 'p4',
      sessionId: null,
    });
    expect(shape(rootOf(down))).toEqual({
      row: [{ column: ['p1', 'p4'], sizes: [50, 50] }, 'p2', 'p3'],
      sizes: [50, 25, 25],
    });
    expect(WorkspaceLayout.safeParse(down).success).toBe(true);
  });

  it('never exceeds the schema limits (8 children per split, panes per tab, 32 tabs)', () => {
    let layout = single;
    for (let i = 2; i <= MAX_SPLIT_CHILDREN + 2; i++) {
      layout = layoutReducer(layout, {
        type: 'split',
        tabId: 't1',
        paneId: layout.tabs[0]!.activePaneId,
        direction: 'row',
        splitId: `s${i}`,
        newPaneId: `p${i}`,
        sessionId: null,
      });
    }
    const root = rootOf(layout);
    expect(root.type === 'split' && root.children.length).toBe(MAX_SPLIT_CHILDREN);
    expect(WorkspaceLayout.safeParse(layout).success).toBe(true);

    let deep = single;
    for (let i = 2; i <= MAX_PANES_PER_TAB + 4; i++) {
      deep = layoutReducer(deep, {
        type: 'split',
        tabId: 't1',
        paneId: deep.tabs[0]!.activePaneId,
        direction: i % 2 ? 'row' : 'column',
        splitId: `d${i}`,
        newPaneId: `q${i}`,
        sessionId: null,
      });
    }
    expect(leaves(rootOf(deep))).toHaveLength(MAX_PANES_PER_TAB);

    let many = EMPTY_LAYOUT;
    for (let i = 0; i < MAX_TABS + 3; i++) {
      many = layoutReducer(many, {
        type: 'openTab',
        tabId: `t${i}`,
        paneId: `p${i}`,
        sessionId: null,
      });
    }
    expect(many.tabs).toHaveLength(MAX_TABS);
    expect(WorkspaceLayout.safeParse(many).success).toBe(true);
  });

  it('closing a pane collapses a split left with one child and moves the focus to a neighbour', () => {
    const split = apply(
      [
        {
          type: 'split',
          tabId: 't1',
          paneId: 'p1',
          direction: 'row',
          splitId: 'a',
          newPaneId: 'p2',
          sessionId: 's2',
        },
        {
          type: 'split',
          tabId: 't1',
          paneId: 'p2',
          direction: 'column',
          splitId: 'b',
          newPaneId: 'p3',
          sessionId: 's3',
        },
      ],
      single,
    );
    expect(shape(rootOf(split))).toEqual({
      row: ['p1', { column: ['p2', 'p3'], sizes: [50, 50] }],
      sizes: [50, 50],
    });
    const closed = layoutReducer(split, { type: 'closePane', tabId: 't1', paneId: 'p3' });
    expect(shape(rootOf(closed))).toEqual({ row: ['p1', 'p2'], sizes: [50, 50] });
    expect(closed.tabs[0]!.activePaneId).toBe('p2');

    const last = apply(
      [
        { type: 'closePane', tabId: 't1', paneId: 'p1' },
        { type: 'closePane', tabId: 't1', paneId: 'p2' },
      ],
      closed,
    );
    // Closing the last pane closes the tab (sessions keep running: nothing is terminated).
    expect(last.tabs).toEqual([]);
    expect(last.activeTabId).toBeNull();
  });

  it('a collapse into a same-direction parent flattens instead of nesting', () => {
    const layout = apply(
      [
        {
          type: 'split',
          tabId: 't1',
          paneId: 'p1',
          direction: 'row',
          splitId: 'a',
          newPaneId: 'p2',
          sessionId: null,
        },
        {
          type: 'split',
          tabId: 't1',
          paneId: 'p2',
          direction: 'column',
          splitId: 'b',
          newPaneId: 'p3',
          sessionId: null,
        },
        {
          type: 'split',
          tabId: 't1',
          paneId: 'p2',
          direction: 'row',
          splitId: 'c',
          newPaneId: 'p4',
          sessionId: null,
        },
        { type: 'closePane', tabId: 't1', paneId: 'p3' },
      ],
      single,
    );
    expect(shape(rootOf(layout))).toEqual({ row: ['p1', 'p2', 'p4'], sizes: [50, 25, 25] });
  });

  it('resizing moves one divider and clamps both sides to the minimum', () => {
    expect(resizeSizes([50, 25, 25], 0, 10)).toEqual([60, 15, 25]);
    expect(resizeSizes([50, 25, 25], 0, 30)).toEqual([65, 10, 25]);
    expect(resizeSizes([50, 50], 0, -80, 20)).toEqual([20, 80]);
    expect(resizeSizes([12, 8], 0, 5, 15)).toEqual([12, 8]); // pair below two minimums
    const split = layoutReducer(single, {
      type: 'split',
      tabId: 't1',
      paneId: 'p1',
      direction: 'row',
      splitId: 'a',
      newPaneId: 'p2',
      sessionId: null,
    });
    const resized = layoutReducer(split, {
      type: 'resize',
      tabId: 't1',
      splitId: 'a',
      index: 0,
      delta: 1000,
      min: 25,
    });
    expect(shape(rootOf(resized))).toEqual({ row: ['p1', 'p2'], sizes: [75, 25] });
    // Already at the limit: same layout object, so nothing is saved.
    expect(
      layoutReducer(resized, {
        type: 'resize',
        tabId: 't1',
        splitId: 'a',
        index: 0,
        delta: 5,
        min: 25,
      }),
    ).toBe(resized);
  });

  it('moves the focus between panes and tabs, and follows sessions without duplicating them', () => {
    const layout = apply(
      [
        {
          type: 'split',
          tabId: 't1',
          paneId: 'p1',
          direction: 'row',
          splitId: 'a',
          newPaneId: 'p2',
          sessionId: 's2',
        },
        { type: 'focusAdjacent', offset: 1 },
      ],
      single,
    );
    expect(layout.tabs[0]!.activePaneId).toBe('p1'); // wrapped from p2
    expect(layoutReducer(layout, { type: 'focusAdjacent', offset: -1 }).tabs[0]!.activePaneId).toBe(
      'p2',
    );

    // Following a session already on screen focuses its pane.
    const followed = layoutReducer(layout, {
      type: 'follow',
      sessionId: 's2',
      tabId: 'x',
      paneId: 'y',
    });
    expect(followed.tabs).toHaveLength(1);
    expect(activeLeaf(followed)?.leaf.id).toBe('p2');

    // A new session opens in a new tab…
    const opened = layoutReducer(followed, {
      type: 'follow',
      sessionId: 's9',
      tabId: 't9',
      paneId: 'p9',
    });
    expect(opened.activeTabId).toBe('t9');
    expect(activeLeaf(opened)?.leaf).toEqual({ type: 'leaf', id: 'p9', sessionId: 's9' });

    // …unless the active pane is empty: then it is bound there.
    const empty = layoutReducer(opened, {
      type: 'split',
      tabId: 't9',
      paneId: 'p9',
      direction: 'column',
      splitId: 'z',
      newPaneId: 'p10',
      sessionId: null,
    });
    const bound = layoutReducer(empty, {
      type: 'follow',
      sessionId: 's7',
      tabId: 'u',
      paneId: 'v',
    });
    expect(bound.tabs).toHaveLength(2);
    expect(activeLeaf(bound)?.leaf).toEqual({ type: 'leaf', id: 'p10', sessionId: 's7' });

    // Closing the active tab activates its right neighbour, else the left one.
    const tabs = apply(
      [
        { type: 'openTab', tabId: 't2', paneId: 'q2', sessionId: null },
        { type: 'openTab', tabId: 't3', paneId: 'q3', sessionId: null },
        { type: 'activateTab', tabId: 't2' },
        { type: 'closeTab', tabId: 't2' },
      ],
      single,
    );
    expect(tabs.activeTabId).toBe('t3');
    expect(layoutReducer(tabs, { type: 'closeTab', tabId: 't3' }).activeTabId).toBe('t1');
  });

  it('normalizes stored layouts: dangling active ids, sizes, single-child splits', () => {
    const stored: WorkspaceLayout = {
      version: 1,
      activeTabId: 'gone',
      tabs: [
        {
          id: 't1',
          activePaneId: 'gone',
          root: {
            type: 'split',
            id: 'a',
            direction: 'row',
            sizes: [1, 3],
            children: [
              { type: 'leaf', id: 'p1', sessionId: null },
              { type: 'leaf', id: 'p2', sessionId: 's2' },
            ],
          },
        },
      ],
    };
    const fixed = normalizeLayout(stored);
    expect(fixed.activeTabId).toBe('t1');
    expect(fixed.tabs[0]!.activePaneId).toBe('p1');
    expect(shape(fixed.tabs[0]!.root)).toEqual({ row: ['p1', 'p2'], sizes: [25, 75] });
  });
});
