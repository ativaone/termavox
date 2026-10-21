'use client';

import type { PaneNode, Tab } from '@termavox/protocol/client';
import { useTranslations } from 'next-intl';
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { sessionTarget } from '../../lib/sessions/target.ts';
import {
  type LayoutAction,
  type LeafNode,
  leaves,
  resizeSizes,
  type SplitNode,
} from '../../lib/workspace/tree.ts';
import { FilesDock } from '../files/files-dock.tsx';
import { FilesCaptionButton } from '../files/files-toggle.tsx';
import { CloseIcon, PlusIcon, TerminalIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Panel } from '../ui/panel.tsx';
import { StateLamp, StatusChip } from '../ui/status-chip.tsx';
import { FULL_WIDTH, usePaneWidth } from './pane-width-preference.ts';
import { TerminalPane } from './terminal-pane.tsx';
import { type PaneMeta, type PanePlace, useWorkspace } from './workspace-context.tsx';

/** Smallest pane, in CSS px, when dragging or nudging a divider. */
const MIN_PANE_PX = { row: 160, column: 96 } as const;
/** Narrowest pane area, in CSS px, when dragging or nudging its trailing edge. */
const MIN_AREA_PX = 320;
const KEY_STEP = 2;
const KEY_STEP_LARGE = 10;

interface TreeProps {
  tab: Tab;
  /** Panes of this tab (more than one draws captions and dims the unfocused ones). */
  paneCount: number;
  paneMeta: Readonly<Record<string, PaneMeta>>;
  dispatch(action: LayoutAction): void;
}

function minPercent(direction: SplitNode['direction'], container: HTMLElement | null): number {
  const rect = container?.getBoundingClientRect();
  const extent = direction === 'row' ? rect?.width : rect?.height;
  if (!extent) return 10;
  return Math.min(45, (MIN_PANE_PX[direction] / extent) * 100);
}

function Divider({
  split,
  index,
  sizes,
  containerRef,
  onPreview,
  onCommit,
}: {
  split: SplitNode;
  index: number;
  sizes: readonly number[];
  containerRef: RefObject<HTMLDivElement | null>;
  onPreview(sizes: number[] | null): void;
  onCommit(delta: number, min: number): void;
}) {
  const t = useTranslations('workspace.pane');
  const row = split.direction === 'row';
  const drag = useRef<{ start: number; extent: number; min: number; delta: number } | null>(null);
  const min = minPercent(split.direction, containerRef.current);
  const pair = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      start: row ? event.clientX : event.clientY,
      extent: row ? rect.width : rect.height,
      min: minPercent(split.direction, containerRef.current),
      delta: 0,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.extent <= 0) return;
    state.delta = (((row ? event.clientX : event.clientY) - state.start) / state.extent) * 100;
    onPreview(resizeSizes(split.sizes, index, state.delta, state.min));
  };
  const finish = () => {
    const state = drag.current;
    drag.current = null;
    onPreview(null);
    if (state && state.delta !== 0) onCommit(state.delta, state.min);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const back = row ? 'ArrowLeft' : 'ArrowUp';
    const forward = row ? 'ArrowRight' : 'ArrowDown';
    let delta = 0;
    if (event.key === back) delta = -step;
    else if (event.key === forward) delta = step;
    else if (event.key === 'Home') delta = -100;
    else if (event.key === 'End') delta = 100;
    else return;
    event.preventDefault();
    onCommit(delta, min);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no native element (<hr> cannot take focus or a value)
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={t('resize')}
      aria-valuenow={Math.round(sizes[index] ?? 0)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(Math.max(min, pair - min))}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      className={cx(
        'group/divider relative z-10 flex shrink-0 touch-none items-center justify-center',
        'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-1',
        row ? 'w-2 cursor-col-resize flex-col' : 'h-2 cursor-row-resize',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'rounded-pill bg-transparent transition-colors duration-(--duration-step) ease-(--ease-out)',
          'group-hover/divider:bg-line-strong group-active/divider:bg-accent group-focus-visible/divider:bg-accent',
          row ? 'h-10 w-0.5' : 'h-0.5 w-10',
        )}
      />
    </div>
  );
}

function SplitView({ node, ...props }: TreeProps & { node: SplitNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number[] | null>(null);
  const sizes = preview ?? node.sizes;
  return (
    <div
      ref={containerRef}
      className={cx(
        'flex h-full w-full min-h-0 min-w-0',
        node.direction === 'row' ? 'flex-row' : 'flex-col',
      )}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 ? (
            <Divider
              split={node}
              index={i - 1}
              sizes={sizes}
              containerRef={containerRef}
              onPreview={setPreview}
              onCommit={(delta, min) =>
                props.dispatch({
                  type: 'resize',
                  tabId: props.tab.id,
                  splitId: node.id,
                  index: i - 1,
                  delta,
                  min,
                })
              }
            />
          ) : null}
          <div className="relative flex min-h-0 min-w-0" style={{ flex: `${sizes[i] ?? 1} 1 0px` }}>
            <TreeNode node={child} {...props} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function PaneCaption({
  leaf,
  place,
  active,
  meta,
}: {
  leaf: LeafNode;
  place: PanePlace;
  active: boolean;
  meta: PaneMeta | undefined;
}) {
  const t = useTranslations('workspace');
  const { labels, closePane } = useWorkspace();
  const session = leaf.sessionId ? labels.get(leaf.sessionId) : undefined;
  const label = session?.label ?? (leaf.sessionId ? t('pane.loading') : t('pane.emptyPane'));
  return (
    <div
      className={cx(
        'flex h-7 shrink-0 items-center gap-2 border-line border-b ps-2.5 pe-0.5',
        active ? 'bg-surface' : 'bg-transparent',
      )}
    >
      {session ? <StateLamp status={session.status} /> : null}
      <span
        className={cx(
          'min-w-0 shrink truncate font-semibold text-xs leading-4',
          active ? 'text-ink' : 'text-ink-muted',
        )}
      >
        {label}
      </span>
      {session ? (
        <span className="shrink-0 text-ink-muted text-xs max-lg:sr-only">
          {t(`status.${session.status}`)}
        </span>
      ) : null}
      {meta?.title ? (
        <span className="min-w-0 flex-1 truncate text-ink-muted text-xs">{meta.title}</span>
      ) : (
        <span className="flex-1" />
      )}
      {leaf.sessionId ? (
        <FilesCaptionButton paneId={leaf.id} sessionId={leaf.sessionId} label={label} />
      ) : null}
      <button
        type="button"
        onClick={() => closePane(place)}
        aria-label={t('pane.closeLabel', { label })}
        title={t('pane.close')}
        className={cx(
          'flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted',
          'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised hover:text-ink',
          'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
        )}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

/** A pane with no session yet (after a split): pick one, or start a new one here. */
function EmptyPane({ place, tab }: { place: PanePlace; tab: Tab }) {
  const t = useTranslations('workspace');
  const { sessions, bindPane, openPalette, focusRequest, closePane } = useWorkspace();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const handled = useRef(0);
  useEffect(() => {
    if (
      !focusRequest ||
      focusRequest.paneId !== place.paneId ||
      handled.current === focusRequest.seq
    ) {
      return;
    }
    handled.current = focusRequest.seq;
    panelRef.current?.querySelector('button')?.focus();
  }, [focusRequest, place.paneId]);

  const shown = new Set(leaves(tab.root).map((l) => l.sessionId));
  const candidates = [...sessions.values()]
    .filter((s) => s.status !== 'ended' && !shown.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, 6);
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-4">
      <Panel aria-labelledby={titleId} floating className="w-full max-w-[24rem]">
        <div ref={panelRef} className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <TerminalIcon size={20} className="text-ink-muted" />
            <h2 id={titleId} className="font-semibold text-ink text-md">
              {t('pane.emptyPane')}
            </h2>
          </div>
          <p className="text-ink-muted text-base">{t('pane.emptyPaneBody')}</p>
          {candidates.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {candidates.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => bindPane(place, session.id)}
                    className={cx(
                      'grid h-11 w-full grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control ps-2.5 pe-2.5 text-start',
                      'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised',
                      'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                    )}
                  >
                    <StateLamp status={session.status} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-semibold text-ink text-sm">
                        {session.label}
                      </span>
                      <span className="truncate text-ink-muted text-xs">
                        {sessionTarget(session, t('localTarget'))}
                      </span>
                    </span>
                    <StatusChip status={session.status} label={t(`status.${session.status}`)} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<PlusIcon size={16} />}
              onClick={() => openPalette(place)}
            >
              {t('pane.newHere')}
            </Button>
            {tab.root.type === 'split' ? (
              <Button variant="quiet" size="sm" onClick={() => closePane(place)}>
                {t('pane.close')}
              </Button>
            ) : null}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function LeafView({ node, tab, paneCount, paneMeta }: TreeProps & { node: LeafNode }) {
  const { closePane } = useWorkspace();
  const place = { tabId: tab.id, paneId: node.id };
  const active = tab.activePaneId === node.id;
  const multi = paneCount > 1;
  return (
    <div
      data-pane={node.id}
      className={cx(
        'flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-row border border-line bg-pane',
        multi && (active ? 'border-t-2 border-t-accent' : 'border-t-2'),
      )}
    >
      {multi ? (
        <PaneCaption leaf={node} place={place} active={active} meta={paneMeta[node.id]} />
      ) : null}
      <div className="relative min-h-0 flex-1">
        {node.sessionId ? (
          <FilesDock paneId={node.id} sessionId={node.sessionId}>
            <TerminalPane
              key={node.id}
              place={place}
              sessionId={node.sessionId}
              active={active}
              dim={multi && !active}
              onClose={() => closePane(place)}
            />
          </FilesDock>
        ) : (
          <EmptyPane place={place} tab={tab} />
        )}
      </div>
    </div>
  );
}

function TreeNode(props: TreeProps & { node: PaneNode }) {
  const { node } = props;
  return node.type === 'leaf' ? (
    <LeafView {...props} node={node} />
  ) : (
    <SplitView {...props} node={node} />
  );
}

/**
 * The pane area at the width its trailing edge was dragged to (per browser, every tab), so a
 * lone pane can be narrowed without a split; the ground shows beyond it. The edge is a divider
 * in the area's gutter, so at full width it takes nothing from the panes. Double-click restores
 * the full width.
 */
function AreaFrame({ children }: { children: ReactNode }) {
  const t = useTranslations('workspace.pane');
  const [stored, setStored] = usePaneWidth();
  const [preview, setPreview] = useState<number | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    start: number;
    extent: number;
    from: number;
    min: number;
    value: number | null;
  } | null>(null);
  const width = preview ?? stored;

  const minWidth = (): number => {
    const extent = frameRef.current?.getBoundingClientRect().width;
    return extent ? Math.min(FULL_WIDTH, (MIN_AREA_PX / extent) * 100) : 10;
  };
  const clamp = (value: number, min: number): number => Math.min(FULL_WIDTH, Math.max(min, value));
  const min = minWidth();

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const extent = frameRef.current?.getBoundingClientRect().width;
    if (!extent) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: event.clientX, extent, from: width, min: minWidth(), value: null };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = ((event.clientX - state.start) / state.extent) * 100;
    state.value = clamp(state.from + delta, state.min);
    setPreview(state.value);
  };
  const finish = () => {
    const value = drag.current?.value ?? null;
    drag.current = null;
    setPreview(null);
    if (value !== null) setStored(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number;
    if (event.key === 'ArrowLeft') next = width - step;
    else if (event.key === 'ArrowRight') next = width + step;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = FULL_WIDTH;
    else return;
    event.preventDefault();
    setStored(clamp(next, min));
  };

  return (
    <div ref={frameRef} className="flex h-full w-full min-h-0 min-w-0">
      <div className="relative flex h-full min-h-0 min-w-0" style={{ width: `${width}%` }}>
        {children}
        {/* biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no native element (<hr> cannot take focus or a value) */}
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('resizeArea')}
          aria-valuenow={Math.round(width)}
          aria-valuemin={Math.round(min)}
          aria-valuemax={FULL_WIDTH}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onDoubleClick={() => setStored(FULL_WIDTH)}
          onKeyDown={onKeyDown}
          className={cx(
            'group/divider absolute inset-y-0 -end-2 z-10 flex w-2 cursor-col-resize touch-none flex-col items-center justify-center',
            'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-1',
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              'h-10 w-0.5 rounded-pill bg-transparent transition-colors duration-(--duration-step) ease-(--ease-out)',
              'group-hover/divider:bg-line-strong group-active/divider:bg-accent group-focus-visible/divider:bg-accent',
            )}
          />
        </div>
      </div>
    </div>
  );
}

/** The active tab's split tree (only the active tab is mounted: one channel per pane). */
export function PaneTree(props: TreeProps) {
  return (
    <AreaFrame>
      <TreeNode {...props} node={props.tab.root} />
    </AreaFrame>
  );
}
