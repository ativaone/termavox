import type { PaneNode, Tab, WorkspaceLayout } from '@termavox/protocol/client';

/**
 * The workspace layout as a pure reducer (plan §9, §11.1): tabs, each holding a split tree whose
 * leaves are panes bound to a session id (or empty). Every result stays valid under the
 * protocol's `WorkspaceLayout` schema (≤ 32 tabs, 2–8 children per split, positive sizes), so a
 * saved layout never fails validation. Actions carry the ids they create, which keeps the
 * reducer deterministic: the same action list replayed on another base layout (a 409 reload)
 * yields the same tabs and panes.
 */

export type SplitDirection = 'row' | 'column';
export type LeafNode = Extract<PaneNode, { type: 'leaf' }>;
export type SplitNode = Extract<PaneNode, { type: 'split' }>;

export const MAX_TABS = 32;
export const MAX_SPLIT_CHILDREN = 8;
/** Panes of the active tab are mounted together; each one is a channel (32 per connection). */
export const MAX_PANES_PER_TAB = 16;
/** Smallest share of a split a pane may keep, in percent, when the UI gives no pixel minimum. */
export const DEFAULT_MIN_SIZE = 10;
const TOTAL = 100;

export type LayoutAction =
  | { type: 'replace'; layout: WorkspaceLayout }
  | { type: 'openTab'; tabId: string; paneId: string; sessionId: string | null }
  | { type: 'closeTab'; tabId: string }
  | { type: 'activateTab'; tabId: string }
  | { type: 'focusPane'; tabId: string; paneId: string }
  /** Moves the focus to the next (+1) or previous (−1) pane of the active tab, wrapping. */
  | { type: 'focusAdjacent'; offset: 1 | -1 }
  | {
      type: 'split';
      tabId: string;
      paneId: string;
      direction: SplitDirection;
      /** Used only when the pane has to be wrapped in a new split node. */
      splitId: string;
      newPaneId: string;
      sessionId: string | null;
    }
  | { type: 'closePane'; tabId: string; paneId: string }
  /** Moves the divider after child `index` by `delta` percent, clamped to `min` on both sides. */
  | { type: 'resize'; tabId: string; splitId: string; index: number; delta: number; min?: number }
  | { type: 'bind'; tabId: string; paneId: string; sessionId: string | null }
  /**
   * Shows a session: focuses the pane that already holds it (active tab first), else binds the
   * active pane when it is empty, else opens it in a new tab (`tabId` / `paneId`).
   */
  | { type: 'follow'; sessionId: string; tabId: string; paneId: string }
  /**
   * "Open in a new tab": switches to the tab (and pane) that already holds the session, alone
   * or in a split, else opens it in a new tab. Never a second tab for the same session.
   */
  | { type: 'showInTab'; sessionId: string; tabId: string; paneId: string };

/** A short random id (96 bits, hex). `crypto.randomUUID` needs a secure context; this does not. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── queries ──────────────────────────────────────────────────────────────────

/** Leaves in reading order (left to right, top to bottom). */
export function leaves(node: PaneNode): LeafNode[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(leaves);
}

export function findLeaf(node: PaneNode, paneId: string): LeafNode | null {
  return leaves(node).find((leaf) => leaf.id === paneId) ?? null;
}

export function activeTab(layout: WorkspaceLayout): Tab | null {
  return layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? null;
}

/** The focused pane of the active tab: the "followed" session on desktop. */
export function activeLeaf(layout: WorkspaceLayout): { tab: Tab; leaf: LeafNode } | null {
  const tab = activeTab(layout);
  if (!tab) return null;
  const leaf = findLeaf(tab.root, tab.activePaneId);
  return leaf ? { tab, leaf } : null;
}

/** Where a session is shown: the active tab first, then the others in order. */
export function findSession(
  layout: WorkspaceLayout,
  sessionId: string,
): { tabId: string; paneId: string } | null {
  const active = activeTab(layout);
  const ordered = active ? [active, ...layout.tabs.filter((t) => t !== active)] : layout.tabs;
  for (const tab of ordered) {
    const current = findLeaf(tab.root, tab.activePaneId);
    if (current?.sessionId === sessionId) return { tabId: tab.id, paneId: current.id };
    const leaf = leaves(tab.root).find((l) => l.sessionId === sessionId);
    if (leaf) return { tabId: tab.id, paneId: leaf.id };
  }
  return null;
}

export function canOpenTab(layout: WorkspaceLayout): boolean {
  return layout.tabs.length < MAX_TABS;
}

export function canSplit(layout: WorkspaceLayout, tabId: string, paneId: string): boolean {
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (!tab || !findLeaf(tab.root, paneId)) return false;
  return leaves(tab.root).length < MAX_PANES_PER_TAB;
}

// ── sizes ────────────────────────────────────────────────────────────────────

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Scales positive sizes to sum to 100 (invalid input becomes equal shares). */
export function normalizeSizes(sizes: readonly number[]): number[] {
  const valid = sizes.length > 0 && sizes.every((s) => Number.isFinite(s) && s > 0);
  if (!valid) return sizes.map(() => round(TOTAL / sizes.length));
  const sum = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => Math.max(0.001, round((s / sum) * TOTAL)));
}

/**
 * Moves the divider between `index` and `index + 1` by `delta` percent. Only that pair changes;
 * both keep at least `min`. A pair too small for two minimums stays as it is.
 */
export function resizeSizes(
  sizes: readonly number[],
  index: number,
  delta: number,
  min: number = DEFAULT_MIN_SIZE,
): number[] {
  const a = sizes[index];
  const b = sizes[index + 1];
  if (a === undefined || b === undefined || !Number.isFinite(delta)) return [...sizes];
  const pair = a + b;
  const floor = Math.max(0.001, Math.min(min, TOTAL / 2));
  if (pair < floor * 2) return [...sizes];
  const nextA = Math.min(pair - floor, Math.max(floor, a + delta));
  const next = [...sizes];
  next[index] = round(nextA);
  next[index + 1] = round(pair - nextA);
  return next;
}

// ── tree edits ───────────────────────────────────────────────────────────────

function leaf(id: string, sessionId: string | null): LeafNode {
  return { type: 'leaf', id, sessionId };
}

function mapLeaves(node: PaneNode, fn: (leaf: LeafNode) => LeafNode): PaneNode {
  if (node.type === 'leaf') return fn(node);
  let changed = false;
  const children = node.children.map((child) => {
    const next = mapLeaves(child, fn);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/**
 * Replaces a child that is a split in the parent's own direction by its children (sizes scaled
 * to the share it had), as long as the parent stays within the child limit.
 */
function flatten(node: SplitNode): SplitNode {
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const share = node.sizes[i] ?? TOTAL / node.children.length;
    const inlineable =
      child.type === 'split' &&
      child.direction === node.direction &&
      node.children.length - 1 + child.children.length <= MAX_SPLIT_CHILDREN;
    if (inlineable) {
      const inner = normalizeSizes(child.sizes);
      child.children.forEach((grand, j) => {
        children.push(grand);
        sizes.push((share * (inner[j] ?? 0)) / TOTAL);
      });
    } else {
      children.push(child);
      sizes.push(share);
    }
  });
  return { ...node, children, sizes: normalizeSizes(sizes) };
}

function splitAt(
  node: PaneNode,
  paneId: string,
  direction: SplitDirection,
  splitId: string,
  added: LeafNode,
): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== paneId) return node;
    return { type: 'split', id: splitId, direction, sizes: [50, 50], children: [node, added] };
  }
  const index = node.children.findIndex((c) => c.type === 'leaf' && c.id === paneId);
  if (index >= 0 && node.direction === direction) {
    if (node.children.length >= MAX_SPLIT_CHILDREN) return node;
    const half = round((node.sizes[index] ?? TOTAL / node.children.length) / 2);
    const children = [...node.children];
    children.splice(index + 1, 0, added);
    const sizes = [...node.sizes];
    sizes.splice(index, 1, half, half);
    return { ...node, children, sizes: normalizeSizes(sizes) };
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = splitAt(child, paneId, direction, splitId, added);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** `undefined`: not found; `null`: the node itself was the removed leaf. */
function removeLeaf(node: PaneNode, paneId: string): PaneNode | null | undefined {
  if (node.type === 'leaf') return node.id === paneId ? null : undefined;
  for (let i = 0; i < node.children.length; i++) {
    const result = removeLeaf(node.children[i]!, paneId);
    if (result === undefined) continue;
    if (result === null) {
      const children = node.children.filter((_, j) => j !== i);
      if (children.length === 1) return children[0]!;
      const sizes = normalizeSizes(node.sizes.filter((_, j) => j !== i));
      return { ...node, children, sizes };
    }
    const children = [...node.children];
    children[i] = result;
    return flatten({ ...node, children });
  }
  return undefined;
}

function mapSplit(node: PaneNode, splitId: string, fn: (split: SplitNode) => SplitNode): PaneNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) return fn(node);
  let changed = false;
  const children = node.children.map((child) => {
    const next = mapSplit(child, splitId, fn);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

// ── layout edits ─────────────────────────────────────────────────────────────

function withTab(layout: WorkspaceLayout, tabId: string, fn: (tab: Tab) => Tab): WorkspaceLayout {
  const index = layout.tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return layout;
  const tab = layout.tabs[index]!;
  const next = fn(tab);
  if (next === tab) return layout;
  const tabs = [...layout.tabs];
  tabs[index] = next;
  return { ...layout, tabs };
}

function openTab(
  layout: WorkspaceLayout,
  tabId: string,
  paneId: string,
  sessionId: string | null,
): WorkspaceLayout {
  if (!canOpenTab(layout) || layout.tabs.some((t) => t.id === tabId)) return layout;
  const tab: Tab = { id: tabId, activePaneId: paneId, root: leaf(paneId, sessionId) };
  const at = layout.tabs.findIndex((t) => t.id === layout.activeTabId);
  const tabs = [...layout.tabs];
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab);
  return { ...layout, tabs, activeTabId: tabId };
}

function closeTab(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const index = layout.tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return layout;
  const tabs = layout.tabs.filter((t) => t.id !== tabId);
  let activeTabId = layout.activeTabId;
  if (activeTabId === tabId) {
    activeTabId = (tabs[index] ?? tabs[index - 1])?.id ?? null;
  }
  return { ...layout, tabs, activeTabId };
}

function focusPane(layout: WorkspaceLayout, tabId: string, paneId: string): WorkspaceLayout {
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (!tab || !findLeaf(tab.root, paneId)) return layout;
  const next = withTab(layout, tabId, (t) =>
    t.activePaneId === paneId ? t : { ...t, activePaneId: paneId },
  );
  return next.activeTabId === tabId ? next : { ...next, activeTabId: tabId };
}

function closePane(layout: WorkspaceLayout, tabId: string, paneId: string): WorkspaceLayout {
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (!tab) return layout;
  const order = leaves(tab.root);
  const at = order.findIndex((l) => l.id === paneId);
  if (at < 0) return layout;
  const root = removeLeaf(tab.root, paneId);
  if (root === null || root === undefined) return closeTab(layout, tabId);
  const activePaneId =
    tab.activePaneId === paneId ? (order[at - 1] ?? order[at + 1])!.id : tab.activePaneId;
  return withTab(layout, tabId, (t) => ({ ...t, root, activePaneId }));
}

export function layoutReducer(layout: WorkspaceLayout, action: LayoutAction): WorkspaceLayout {
  switch (action.type) {
    case 'replace':
      return normalizeLayout(action.layout);
    case 'openTab':
      return openTab(layout, action.tabId, action.paneId, action.sessionId);
    case 'closeTab':
      return closeTab(layout, action.tabId);
    case 'activateTab':
      return layout.activeTabId !== action.tabId && layout.tabs.some((t) => t.id === action.tabId)
        ? { ...layout, activeTabId: action.tabId }
        : layout;
    case 'focusPane':
      return focusPane(layout, action.tabId, action.paneId);
    case 'focusAdjacent': {
      const tab = activeTab(layout);
      if (!tab) return layout;
      const order = leaves(tab.root);
      if (order.length < 2) return layout;
      const at = Math.max(
        0,
        order.findIndex((l) => l.id === tab.activePaneId),
      );
      const target = order[(at + action.offset + order.length) % order.length]!;
      return focusPane(layout, tab.id, target.id);
    }
    case 'split': {
      if (!canSplit(layout, action.tabId, action.paneId)) return layout;
      const added = leaf(action.newPaneId, action.sessionId);
      const next = withTab(layout, action.tabId, (tab) => {
        const root = splitAt(tab.root, action.paneId, action.direction, action.splitId, added);
        return root === tab.root ? tab : { ...tab, root, activePaneId: action.newPaneId };
      });
      return next === layout ? layout : { ...next, activeTabId: action.tabId };
    }
    case 'closePane':
      return closePane(layout, action.tabId, action.paneId);
    case 'resize':
      return withTab(layout, action.tabId, (tab) => {
        const root = mapSplit(tab.root, action.splitId, (split) => {
          const sizes = resizeSizes(split.sizes, action.index, action.delta, action.min);
          return sizes.every((s, i) => s === split.sizes[i]) ? split : { ...split, sizes };
        });
        return root === tab.root ? tab : { ...tab, root };
      });
    case 'bind':
      return withTab(layout, action.tabId, (tab) => {
        const root = mapLeaves(tab.root, (l) =>
          l.id === action.paneId && l.sessionId !== action.sessionId
            ? { ...l, sessionId: action.sessionId }
            : l,
        );
        return root === tab.root ? tab : { ...tab, root };
      });
    case 'follow': {
      const found = findSession(layout, action.sessionId);
      if (found) return focusPane(layout, found.tabId, found.paneId);
      const current = activeLeaf(layout);
      if (current && current.leaf.sessionId === null) {
        return layoutReducer(layout, {
          type: 'bind',
          tabId: current.tab.id,
          paneId: current.leaf.id,
          sessionId: action.sessionId,
        });
      }
      return openTab(layout, action.tabId, action.paneId, action.sessionId);
    }
    case 'showInTab': {
      const found = findSession(layout, action.sessionId);
      return found
        ? focusPane(layout, found.tabId, found.paneId)
        : openTab(layout, action.tabId, action.paneId, action.sessionId);
    }
  }
}

/**
 * Repairs a schema-valid layout for use: an existing active tab, an active pane that is a leaf
 * of its tab, sizes that sum to 100, and no split nested in a split of the same direction.
 */
export function normalizeLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const fix = (node: PaneNode): PaneNode => {
    if (node.type === 'leaf') return node;
    const children = node.children.map(fix);
    if (children.length === 1) return children[0]!;
    return flatten({ ...node, children, sizes: normalizeSizes(node.sizes) });
  };
  const tabs = layout.tabs.slice(0, MAX_TABS).map((tab) => {
    const root = fix(tab.root);
    const activePaneId = findLeaf(root, tab.activePaneId) ? tab.activePaneId : leaves(root)[0]!.id;
    return { ...tab, root, activePaneId };
  });
  const activeTabId = tabs.some((t) => t.id === layout.activeTabId)
    ? layout.activeTabId
    : (tabs[0]?.id ?? null);
  return { version: 1, activeTabId, tabs };
}
