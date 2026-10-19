'use client';

import type { Tab, WorkspaceLayout } from '@termdock/protocol/client';
import { useTranslations } from 'next-intl';
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import type { SessionLabel } from '../../lib/sessions/types.ts';
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
 */
export function TabBar({
  layout,
  sessions,
  paneMeta,
  onSelect,
  onClose,
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
    if (strip && item && keepActive.current && !fullyVisible(strip, item)) {
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
    if (!strip || !item) return;
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

  // A 20 px fade over the clipped end of the strip: a muted chevron points at the hidden tabs,
  // and its shadow falls on the tabs that slide under it.
  const edgeClass = cx(
    'pointer-events-none absolute inset-y-0 flex w-5 items-center justify-center text-ink-muted',
    'transition-opacity duration-(--duration-step) ease-(--ease-out)',
  );

  return (
    <div className="flex h-(--tabbar-height) shrink-0 items-center gap-3 ps-2 pe-2">
      <nav aria-label={t('tabs.label')} className="relative flex min-w-0 flex-1 self-stretch">
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
                    // Keyboard focus never rests under an edge.
                    onFocus={(event) => {
                      const strip = stripRef.current;
                      if (strip) reveal(strip, event.currentTarget, smoothUnlessReduced());
                    }}
                    className={cx(
                      'relative flex h-8 min-w-28 max-w-60 shrink-0 items-stretch overflow-hidden rounded-control',
                      'transition-colors duration-(--duration-step) ease-(--ease-out)',
                      active
                        ? 'bg-surface-raised text-ink after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-pill after:bg-accent'
                        : 'text-ink-muted hover:bg-surface hover:text-ink',
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
                        onClick={() => onSelect(view.tab.id)}
                        onDoubleClick={() => startEdit(view)}
                        title={view.sessionId ? t('tabs.renameHint') : undefined}
                        className="flex min-w-0 flex-1 items-center gap-2 ps-2.5 pe-1 text-start focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2"
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
