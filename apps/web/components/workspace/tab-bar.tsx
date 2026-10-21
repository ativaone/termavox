'use client';

import type { Tab, WorkspaceLayout } from '@termavox/protocol/client';
import { useTranslations } from 'next-intl';
import {
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import type { SessionLabel } from '../../lib/sessions/types.ts';
import {
  autoScrollStep,
  clampStart,
  DRAG_THRESHOLD,
  landingIndex,
  type Slot,
  shiftOf,
} from '../../lib/workspace/tab-drag.ts';
import { findLeaf, leaves } from '../../lib/workspace/tree.ts';
import {
  BellIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  SplitDownIcon,
  SplitRightIcon,
} from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { StateLamp } from '../ui/status-chip.tsx';
import { useRenameSession } from './hooks.ts';
import type { PaneMeta } from './workspace-context.tsx';

/** Room kept beside a revealed tab: the edge cue (20 px) plus a peek of its neighbour. */
const REVEAL_MARGIN = 36;
/** A wheel line (Firefox `deltaMode` 1) in pixels. */
const WHEEL_LINE = 16;
/**
 * A tab sliding to its place at the move step, its colours still easing at the step as the
 * classes' own transition does (both instant under reduced motion: the tokens are 0).
 */
const SLIDE = [
  'transform var(--duration-move) var(--ease-out)',
  'background-color var(--duration-step) var(--ease-out)',
  'color var(--duration-step) var(--ease-out)',
].join(', ');
/** Longer than a slide: then the inline transitions go and the classes' own apply again. */
const SLIDE_CLEAR_MS = 250;

/** A press on a tab's label, from the pointer going down to its release. */
interface Press {
  pointerId: number;
  tabId: string;
  button: HTMLButtonElement;
  /** Where the keyboard focus was before the press: a drag gives it back. */
  focus: Element | null;
  /** The pointer at the press, in px: on screen and in the strip's content. */
  downX: number;
  downContentX: number;
  /** The pointer's latest horizontal position on screen. */
  x: number;
  /** `pressed` until the pointer travels far enough; `cancelled` still swallows the release. */
  phase: 'pressed' | 'dragging' | 'cancelled';
  // Measured when the drag begins: the order, every tab's resting slot and the dragged one's.
  ids: string[];
  slots: Slot[];
  from: number;
  /** Where the dragged tab lands now, and where it is drawn (its start in the content). */
  to: number;
  start: number;
  /** The strip's scroll position the drawing last followed. */
  scroll: number;
  frame: number;
  /** Ends the press at once: a drag in progress goes back and nothing is moved. */
  abort(): void;
}

interface TabView {
  tab: Tab;
  /** The focused pane's session (the one the label names), if any. */
  sessionId: string | null;
  label: string;
  title: string | null;
  session: SessionLabel | undefined;
  panes: number;
  bell: boolean;
}

function viewOf(
  tab: Tab,
  sessions: ReadonlyMap<string, SessionLabel>,
  paneMeta: Readonly<Record<string, PaneMeta>>,
  fallback: { empty: string; loading: string },
): TabView {
  const all = leaves(tab.root);
  const current = findLeaf(tab.root, tab.activePaneId) ?? all[0]!;
  const session = current.sessionId ? sessions.get(current.sessionId) : undefined;
  return {
    tab,
    sessionId: current.sessionId ?? null,
    label: session?.label ?? (current.sessionId ? fallback.loading : fallback.empty),
    title: paneMeta[current.id]?.title ?? null,
    session,
    panes: all.length,
    bell: all.some((leaf) => paneMeta[leaf.id]?.bell),
  };
}

const smoothUnlessReduced = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';

/**
 * Scrolls `strip` (horizontally only, never an ancestor) so `item` is fully visible with room
 * for the edge cue beside it.
 */
function reveal(strip: HTMLElement, item: HTMLElement, behavior: ScrollBehavior): void {
  const start = item.offsetLeft;
  const end = start + item.offsetWidth;
  const viewStart = strip.scrollLeft;
  const viewEnd = viewStart + strip.clientWidth;
  let left: number | null = null;
  if (start - REVEAL_MARGIN < viewStart) left = Math.max(0, start - REVEAL_MARGIN);
  else if (end + REVEAL_MARGIN > viewEnd) left = end + REVEAL_MARGIN - strip.clientWidth;
  if (left !== null) strip.scrollTo({ left, behavior });
}

/** The active tab's item in the strip, if any. */
function activeItem(strip: HTMLElement): HTMLElement | null {
  return strip.querySelector('button[aria-current="true"]')?.closest('li') ?? null;
}

function fullyVisible(strip: HTMLElement, item: HTMLElement): boolean {
  const start = item.offsetLeft;
  return (
    start >= strip.scrollLeft - 1 &&
    start + item.offsetWidth <= strip.scrollLeft + strip.clientWidth + 1
  );
}

/**
 * The tab row: one tab per split tree, labelled by its focused pane's session (lamp, label, OSC
 * title, bell). The active tab is a lit segment with the cyan underline, the reading light's
 * second stop; closing a tab only detaches. The tabs scroll sideways in their own strip; the
 * split controls and the connection state sit beside it on the trailing edge, never over it.
 * The active tab is scrolled into view whenever it changes or is followed again, and kept
 * there when the strip or the tabs change size; an edge that has tabs scrolled under it shows a
 * chevron cue whose shadow falls on them.
 *
 * Tabs reorder by dragging a label sideways (past a few px of travel; less is a click) or with
 * Ctrl+Shift+←/→ on a focused tab. The dragged tab is lifted and follows the pointer along the
 * strip while its neighbours slide aside to open the slot it lands in; near either end the strip
 * scrolls. Escape, a lost pointer or the window losing focus put it back. The drop reports the
 * new index once (`onMove`), and the strip stays where the drop left it.
 */
export function TabBar({
  layout,
  sessions,
  paneMeta,
  onSelect,
  onClose,
  onMove,
  onSplit,
  canSplit,
  revealKey = 0,
  trailing,
  files,
  onRenameError,
}: {
  layout: WorkspaceLayout;
  /** Label and status per session (server-rendered until live data arrives). */
  sessions: ReadonlyMap<string, SessionLabel>;
  paneMeta: Readonly<Record<string, PaneMeta>>;
  onSelect(tabId: string): void;
  onClose(tabId: string): void;
  /** Puts a tab at `toIndex` of the resulting order (a drop or Ctrl+Shift+←/→). */
  onMove(tabId: string, toIndex: number): void;
  onSplit(direction: 'row' | 'column'): void;
  canSplit: boolean;
  /** Changes whenever a session is followed or a tab selected, even the already active one. */
  revealKey?: number;
  trailing?: ReactNode;
  /** The Files toggle of a one-pane tab (plan D-39), before the split controls. */
  files?: ReactNode;
  /** A rename the daemon refused (shown by the shell's notice bar). */
  onRenameError?(message: string): void;
}) {
  const t = useTranslations('workspace');
  const rename = useRenameSession();
  // Inline rename (plan D-28): double-click a tab's label to edit it in place.
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null);
  /** Escape sets this before the input blurs, so the blur does not save. */
  const cancelled = useRef(false);
  /** The edit field mounts once per edit: take the keyboard and select the current name. */
  const mountEdit = (element: HTMLInputElement | null) => {
    if (element && document.activeElement !== element) {
      element.focus();
      element.select();
    }
  };
  const startEdit = (view: TabView) => {
    if (!view.sessionId || !view.session) return;
    cancelled.current = false;
    setEditing({ tabId: view.tab.id, value: view.label });
  };
  const finishEdit = async (view: TabView, save: boolean) => {
    const state = editing;
    setEditing(null);
    if (!save || !state || !view.sessionId || state.value === view.label) return;
    const result = await rename(view.sessionId, state.value);
    if (!result.ok) onRenameError?.(result.message);
  };
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const items = useRef(new Map<string, HTMLLIElement>());
  const stripRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const shownEdges = useRef(edges);
  const observer = useRef<ResizeObserver | null>(null);
  /** The active tab was fully in view after the last scroll: size changes keep it there. */
  const keepActive = useRef(true);
  /**
   * The strip width the last resize handled. A scroll event that arrives at another width is the
   * browser clamping `scrollLeft` for a size change the resize handler has not seen yet (a status
   * chip hiding and coming back between two frames), not the user scrolling.
   */
  const handledWidth = useRef<number | null>(null);
  /**
   * Set from a press on a tab until its drag has settled: nothing reveals a tab or scrolls the
   * strip under the user's hand meanwhile (auto-scroll aside).
   */
  const holdStrip = useRef(false);
  const fallback = { empty: t('pane.emptyPane'), loading: t('pane.loading') };
  const views = layout.tabs.map((tab) => viewOf(tab, sessions, paneMeta, fallback));

  // Which edges have tabs scrolled under them. Called from scroll and resize events only (never
  // from a render), and it sets state only when an edge actually changes.
  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const start = strip.scrollLeft > 1;
    const end = strip.scrollLeft < max - 1;
    const shown = shownEdges.current;
    if (shown.start === start && shown.end === end) return;
    shownEdges.current = { start, end };
    setEdges(shownEdges.current);
  }, []);
  const onStripScroll = useCallback(() => {
    const strip = stripRef.current;
    const item = strip ? activeItem(strip) : null;
    // Scrolled away by hand: later size changes leave the strip where the user put it.
    if (strip && item && strip.clientWidth === handledWidth.current) {
      keepActive.current = fullyVisible(strip, item);
    }
    measure();
  }, [measure]);
  const onResize = useCallback(() => {
    const strip = stripRef.current;
    const item = strip ? activeItem(strip) : null;
    if (strip && item && keepActive.current && !holdStrip.current && !fullyVisible(strip, item)) {
      reveal(strip, item, 'instant');
    }
    if (strip) handledWidth.current = strip.clientWidth;
    measure();
  }, [measure]);
  const setStrip = useCallback((element: HTMLUListElement | null) => {
    if (stripRef.current && stripRef.current !== element) {
      observer.current?.unobserve(stripRef.current);
    }
    stripRef.current = element;
    if (element) observer.current?.observe(element);
  }, []);
  // The strip's own size (a status appearing beside it, the window) and every tab's width
  // (labels arriving after a restore, titles, web fonts loading, tabs added or removed).
  useLayoutEffect(() => {
    const resize = new ResizeObserver(onResize);
    observer.current = resize;
    if (stripRef.current) resize.observe(stripRef.current);
    for (const item of items.current.values()) resize.observe(item);
    return () => {
      resize.disconnect();
      observer.current = null;
    };
  }, [onResize]);

  // The active tab comes into view when it changes, when tabs open or close, and when it is
  // followed again (from the sidebar, the palette, a new tab); instantly on the first paint.
  const activeTabId = layout.activeTabId;
  const tabCount = layout.tabs.length;
  const painted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabCount and revealKey are the triggers
  useEffect(() => {
    const strip = stripRef.current;
    const item = activeTabId ? items.current.get(activeTabId) : undefined;
    if (!strip || !item || holdStrip.current) return;
    const behavior = painted.current ? smoothUnlessReduced() : 'instant';
    painted.current = true;
    keepActive.current = true;
    reveal(strip, item, behavior);
    measure();
  }, [activeTabId, tabCount, revealKey, measure]);

  // A mouse wheel scrolls the strip sideways (the scrollbar is hidden).
  const onWheel = (event: WheelEvent<HTMLUListElement>) => {
    const strip = event.currentTarget;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += event.deltaY * (event.deltaMode === 1 ? WHEEL_LINE : 1);
  };

  const close = (event: MouseEvent, index: number) => {
    const id = layout.tabs[index]!.id;
    // Keyboard users stay in the tab bar: the focus moves to the neighbouring tab.
    const neighbour = layout.tabs[index + 1] ?? layout.tabs[index - 1];
    onClose(id);
    if (event.detail === 0 && neighbour) {
      requestAnimationFrame(() => refs.current.get(neighbour.id)?.focus());
    }
  };

  // ── reordering ─────────────────────────────────────────────────────────────
  const press = useRef<Press | null>(null);
  /** The tab being dragged: lifted, while its neighbours slide (transforms are set directly). */
  const [dragged, setDragged] = useState<string | null>(null);
  /** A drag that just ended: its tab slides from where it was drawn into its slot. */
  const settle = useRef<{ tabId: string; start: number; focus: Element | null } | null>(null);
  /** The click that follows a drag's release selects nothing. */
  const swallowClick = useRef(false);
  const slideTimer = useRef<number | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const onLabelPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, tabId: string) => {
    swallowClick.current = false;
    const strip = stripRef.current;
    if (event.button !== 0 || event.pointerType === 'touch' || !strip) return;
    // A press whose release never came (let go outside the window) ends with this one.
    press.current?.abort();
    if (editing || layout.tabs.length < 2) return;
    const p: Press = {
      pointerId: event.pointerId,
      tabId,
      button: event.currentTarget,
      focus: document.activeElement,
      downX: event.clientX,
      downContentX: event.clientX - strip.getBoundingClientRect().left + strip.scrollLeft,
      x: event.clientX,
      phase: 'pressed',
      ids: [],
      slots: [],
      from: -1,
      to: -1,
      start: 0,
      scroll: strip.scrollLeft,
      frame: 0,
      abort: () => {
        endDrag(false);
        release();
      },
    };
    press.current = p;
    holdStrip.current = true;

    // Draws the dragged tab under the pointer and opens its landing slot.
    function follow() {
      const strip = stripRef.current;
      const item = items.current.get(p.tabId);
      if (!strip || !item) return;
      const own = p.slots[p.from]!;
      p.scroll = strip.scrollLeft;
      const pointer = p.x - strip.getBoundingClientRect().left + strip.scrollLeft;
      p.start = clampStart(p.slots, p.from, own.start + pointer - p.downContentX, {
        start: strip.scrollLeft,
        end: strip.scrollLeft + strip.clientWidth,
      });
      item.style.transform = `translateX(${p.start - own.start}px)`;
      const to = landingIndex(p.slots, p.from, p.start);
      if (to === p.to) return;
      p.to = to;
      p.ids.forEach((id, index) => {
        const element = items.current.get(id);
        if (index === p.from || !element) return;
        const shift = shiftOf(p.slots, p.from, to, index);
        element.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    }
    // Every frame of a drag: scroll near an end, and follow any scroll (the wheel's too).
    function tick() {
      const strip = stripRef.current;
      if (press.current !== p || p.phase !== 'dragging' || !strip) return;
      const rect = strip.getBoundingClientRect();
      const step = autoScrollStep(p.x, rect.left, rect.right);
      if (step !== 0) strip.scrollLeft += step;
      if (strip.scrollLeft !== p.scroll) follow();
      p.frame = requestAnimationFrame(tick);
    }
    function begin(): boolean {
      const ids = layout.tabs.map((tab) => tab.id);
      const from = ids.indexOf(p.tabId);
      const elements = ids.map((id) => items.current.get(id));
      if (from < 0 || !elements.every((element) => element !== undefined)) return false;
      try {
        p.button.setPointerCapture(p.pointerId);
      } catch {
        return false; // the pointer is gone
      }
      if (slideTimer.current !== null) window.clearTimeout(slideTimer.current);
      slideTimer.current = null;
      for (const element of elements) {
        element.style.transform = '';
        element.style.transition = '';
      }
      p.ids = ids;
      p.slots = elements.map((element) => ({
        start: element.offsetLeft,
        size: element.offsetWidth,
      }));
      p.from = from;
      p.to = from;
      p.phase = 'dragging';
      elements.forEach((element, index) => {
        if (index !== from) element.style.transition = SLIDE;
      });
      setDragged(p.tabId);
      follow();
      p.frame = requestAnimationFrame(tick);
      return true;
    }
    // A drop reorders the tabs right where they slid to, so they stop there; anything else
    // slides them home. The dragged tab settles after the commit (see the layout effect below).
    function endDrag(drop: boolean) {
      if (p.phase !== 'dragging') return;
      p.phase = 'cancelled';
      cancelAnimationFrame(p.frame);
      const moved = drop && p.to !== p.from;
      p.ids.forEach((id, index) => {
        const element = items.current.get(id);
        if (index === p.from || !element) return;
        element.style.transition = moved ? 'none' : SLIDE;
        element.style.transform = '';
      });
      settle.current = { tabId: p.tabId, start: p.start, focus: p.focus };
      setDragged(null);
      if (moved) onMove(p.tabId, p.to);
    }
    function release() {
      if (press.current !== p) return;
      press.current = null;
      cancelAnimationFrame(p.frame);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', p.abort);
      p.button.removeEventListener('lostpointercapture', onLostCapture);
      if (p.button.hasPointerCapture(p.pointerId)) p.button.releasePointerCapture(p.pointerId);
      // A plain click lets the strip go now; a drag lets it go once it has settled.
      if (p.phase === 'pressed') holdStrip.current = false;
    }
    function onPointerMove(move: PointerEvent) {
      if (move.pointerId !== p.pointerId) return;
      if ((move.buttons & 1) === 0) {
        p.abort(); // released where this page could not hear it
        return;
      }
      p.x = move.clientX;
      if (p.phase === 'pressed' && Math.abs(p.x - p.downX) >= DRAG_THRESHOLD && !begin()) {
        release();
      } else if (p.phase === 'dragging') {
        follow();
      }
    }
    function onPointerUp(up: PointerEvent) {
      if (up.pointerId !== p.pointerId) return;
      const dragging = p.phase !== 'pressed';
      endDrag(true);
      release();
      if (dragging) {
        swallowClick.current = true;
        window.setTimeout(() => {
          swallowClick.current = false;
        }, 0);
      }
    }
    function onPointerCancel(cancel: PointerEvent) {
      if (cancel.pointerId === p.pointerId) p.abort();
    }
    function onLostCapture() {
      if (p.phase === 'dragging') p.abort();
    }
    // Escape puts the tab back; the pointer is still down, so its release is swallowed too.
    function onKeyDown(key: KeyboardEvent) {
      if (key.key !== 'Escape' || p.phase !== 'dragging') return;
      key.preventDefault();
      key.stopPropagation();
      endDrag(false);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', p.abort);
    p.button.addEventListener('lostpointercapture', onLostCapture);
  };

  // After a drag ends: the dragged tab slides from where it was drawn into its slot (wherever the
  // reorder put it), the strip stays where it is, and the focus goes back where it was.
  useLayoutEffect(() => {
    const done = settle.current;
    if (!done) return;
    settle.current = null;
    const item = items.current.get(done.tabId);
    if (item) {
      item.style.transition = 'none';
      item.style.transform = `translateX(${done.start - item.offsetLeft}px)`;
      void item.offsetWidth; // commit that start before sliding from it
      item.style.transition = SLIDE;
      item.style.transform = '';
    }
    if (slideTimer.current !== null) window.clearTimeout(slideTimer.current);
    slideTimer.current = window.setTimeout(() => {
      slideTimer.current = null;
      for (const element of items.current.values()) element.style.transition = '';
    }, SLIDE_CLEAR_MS);
    const strip = stripRef.current;
    const active = strip ? activeItem(strip) : null;
    if (strip && active) keepActive.current = fullyVisible(strip, active);
    const focus = done.focus;
    if (focus instanceof HTMLElement && focus.isConnected && focus !== document.body) {
      focus.focus({ preventScroll: true });
    }
    holdStrip.current = false;
  });

  // A drag whose tabs change under it (closed elsewhere, another browser's layout) is put back.
  const order = layout.tabs.map((tab) => tab.id).join(' ');
  useEffect(() => {
    const p = press.current;
    if (p?.phase === 'dragging' && p.ids.join(' ') !== order) p.abort();
  }, [order]);
  useEffect(
    () => () => {
      press.current?.abort();
      if (slideTimer.current !== null) window.clearTimeout(slideTimer.current);
    },
    [],
  );

  // Ctrl+Shift+←/→ on a focused tab moves it one place; the focus stays on it.
  const onLabelKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (step === 0 || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    const tab = layout.tabs[index];
    const to = index + step;
    if (!tab || press.current || to < 0 || to >= layout.tabs.length) return;
    onMove(tab.id, to);
    setAnnouncement(t('tabs.moved', { position: to + 1, count: layout.tabs.length }));
    // Moving its item in the page can take the focus away: give it back, and keep it in view.
    requestAnimationFrame(() => {
      const button = refs.current.get(tab.id);
      const strip = stripRef.current;
      const item = items.current.get(tab.id);
      if (button && (document.activeElement === null || document.activeElement === document.body)) {
        button.focus({ preventScroll: true });
      }
      if (strip && item) reveal(strip, item, smoothUnlessReduced());
    });
  };

  // A 20 px fade over the clipped end of the strip: a muted chevron points at the hidden tabs,
  // and its shadow falls on the tabs that slide under it (a dragged one included).
  const edgeClass = cx(
    'pointer-events-none absolute inset-y-0 z-20 flex w-5 items-center justify-center text-ink-muted',
    'transition-opacity duration-(--duration-step) ease-(--ease-out)',
  );
  const movable = views.length > 1;
  const hint = (view: TabView): string | undefined => {
    if (!movable) return view.sessionId ? t('tabs.renameHint') : undefined;
    return view.sessionId ? t('tabs.renameMoveHint') : t('tabs.moveHint');
  };

  return (
    <div className="flex h-(--tabbar-height) shrink-0 items-center gap-3 ps-2 pe-2">
      <nav
        aria-label={t('tabs.label')}
        className="relative isolate flex min-w-0 flex-1 self-stretch"
      >
        {views.length === 0 ? (
          <p className="self-center px-2 text-ink-muted text-xs">{t('tabs.empty')}</p>
        ) : (
          <>
            <ul
              ref={setStrip}
              onScroll={onStripScroll}
              onWheel={onWheel}
              className="relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {views.map((view, index) => {
                const active = view.tab.id === layout.activeTabId;
                const lifted = view.tab.id === dragged;
                const status = view.session?.status;
                return (
                  <li
                    key={view.tab.id}
                    ref={(element) => {
                      const id = view.tab.id;
                      const previous = items.current.get(id);
                      if (previous && previous !== element) observer.current?.unobserve(previous);
                      if (element) {
                        items.current.set(id, element);
                        observer.current?.observe(element);
                      } else {
                        items.current.delete(id);
                      }
                    }}
                    // Keyboard focus never rests under an edge. A press on a label focuses it
                    // too; then the strip holds still (a click reveals the tab it selects).
                    onFocus={(event) => {
                      const strip = stripRef.current;
                      if (strip && !holdStrip.current) {
                        reveal(strip, event.currentTarget, smoothUnlessReduced());
                      }
                    }}
                    className={cx(
                      'relative flex h-8 min-w-28 max-w-60 shrink-0 items-stretch overflow-hidden rounded-control',
                      'transition-colors duration-(--duration-step) ease-(--ease-out)',
                      // Dragged, the tab is lifted over its neighbours: solid, casting the
                      // row's sideways Edge shadow on both of them (the strip clips any other).
                      lifted
                        ? 'z-10 cursor-grabbing bg-surface-solid text-ink [box-shadow:var(--shadow-edge-start),var(--shadow-edge-end)]'
                        : active
                          ? 'bg-surface-raised text-ink'
                          : 'text-ink-muted hover:bg-surface hover:text-ink',
                      active &&
                        'after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-pill after:bg-accent',
                    )}
                  >
                    {editing?.tabId === view.tab.id ? (
                      <span className="flex min-w-0 flex-1 items-center gap-2 ps-2.5 pe-1">
                        {status ? <StateLamp status={status} /> : null}
                        <input
                          ref={mountEdit}
                          type="text"
                          value={editing.value}
                          aria-label={t('tabs.renameLabel', { label: view.label })}
                          maxLength={1024}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) =>
                            setEditing({ tabId: view.tab.id, value: event.target.value })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void finishEdit(view, true);
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelled.current = true;
                              void finishEdit(view, false);
                            }
                          }}
                          onBlur={() => {
                            if (!cancelled.current) void finishEdit(view, true);
                          }}
                          className="h-6 min-w-0 flex-1 rounded-sm border border-accent bg-field px-1.5 font-semibold text-ink text-sm outline-none"
                        />
                      </span>
                    ) : (
                      <button
                        ref={(element) => {
                          if (element) refs.current.set(view.tab.id, element);
                          else refs.current.delete(view.tab.id);
                        }}
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        aria-keyshortcuts={
                          movable ? 'Control+Shift+ArrowLeft Control+Shift+ArrowRight' : undefined
                        }
                        onPointerDown={(event) => onLabelPointerDown(event, view.tab.id)}
                        onKeyDown={(event) => onLabelKeyDown(event, index)}
                        onClick={() => {
                          if (!swallowClick.current) onSelect(view.tab.id);
                        }}
                        onDoubleClick={() => {
                          if (!swallowClick.current) startEdit(view);
                        }}
                        title={hint(view)}
                        className={cx(
                          'flex min-w-0 flex-1 select-none items-center gap-2 ps-2.5 pe-1 text-start',
                          'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                          lifted && 'cursor-grabbing',
                        )}
                      >
                        {status ? (
                          <StateLamp status={status} />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-pill bg-line-strong"
                          />
                        )}
                        <span className="min-w-0 truncate font-semibold text-sm">{view.label}</span>
                        {view.title ? (
                          <span className="min-w-0 flex-1 truncate text-ink-muted text-xs">
                            {view.title}
                          </span>
                        ) : (
                          <span className="flex-1" />
                        )}
                        {view.panes > 1 ? (
                          <span
                            aria-hidden="true"
                            className="shrink-0 rounded-pill bg-surface-raised px-1.5 font-data font-semibold text-2xs text-ink-muted"
                          >
                            {view.panes}
                          </span>
                        ) : null}
                        {view.bell ? (
                          <BellIcon size={14} className="shrink-0 text-attention" />
                        ) : null}
                        <span className="sr-only">
                          {status ? `, ${t(`status.${status}`)}` : ''}
                          {view.panes > 1 ? `, ${t('tabs.panes', { count: view.panes })}` : ''}
                          {view.bell ? `, ${t('tabs.bell')}` : ''}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(event) => close(event, index)}
                      aria-label={t('tabs.closeLabel', { label: view.label })}
                      title={t('tabs.close')}
                      className={cx(
                        'my-1 me-1 flex w-6 shrink-0 items-center justify-center rounded-sm text-ink-muted',
                        'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-pressed hover:text-ink',
                        'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                      )}
                    >
                      <CloseIcon size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
            {/* Overflow cues: the row's own edge, casting a shadow over the tabs under it. */}
            <span
              aria-hidden="true"
              data-edge="start"
              className={cx(
                edgeClass,
                'start-0 bg-[linear-gradient(to_right,var(--color-ground),transparent)] shadow-edge-start',
                edges.start ? 'opacity-100' : 'opacity-0',
              )}
            >
              <ChevronLeftIcon size={14} />
            </span>
            <span
              aria-hidden="true"
              data-edge="end"
              className={cx(
                edgeClass,
                'end-0 bg-[linear-gradient(to_left,var(--color-ground),transparent)] shadow-edge-end',
                edges.end ? 'opacity-100' : 'opacity-0',
              )}
            >
              <ChevronRightIcon size={14} />
            </span>
          </>
        )}
        {/* Where a moved tab now sits, for screen readers (Ctrl+Shift+←/→). */}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </nav>
      <div className="flex shrink-0 items-center gap-1 self-center whitespace-nowrap">
        {trailing}
        {files}
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          disabled={!canSplit}
          onClick={() => onSplit('row')}
          aria-label={t('tabs.splitRight')}
          title={t('tabs.splitRight')}
          icon={<SplitRightIcon size={16} />}
        />
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          disabled={!canSplit}
          onClick={() => onSplit('column')}
          aria-label={t('tabs.splitDown')}
          title={t('tabs.splitDown')}
          icon={<SplitDownIcon size={16} />}
        />
      </div>
    </div>
  );
}
