'use client';

import { useTranslations } from 'next-intl';
import { type KeyboardEvent, type PointerEvent, useRef } from 'react';
import { PANEL_DIVIDER_WIDTH, PANEL_MIN_WIDTH } from '../../lib/files/pane-state.ts';
import { cx } from '../ui/cx.ts';

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/**
 * The draggable edge between a pane's terminal and its docked file panel: the split dividers'
 * contract (a focusable separator, arrows nudge, Shift nudges more, Home and End go to the ends)
 * in pixels of panel width. Dragging left widens the panel.
 */
export function PanelDivider({
  width,
  max,
  onResize,
}: {
  width: number;
  max: number;
  onResize(width: number): void;
}) {
  const t = useTranslations('files');
  const drag = useRef<{ start: number; width: number } | null>(null);
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, value)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const next = clamp(state.width + (state.start - event.clientX));
    if (next !== width) onResize(next);
  };
  const finish = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number;
    if (event.key === 'ArrowLeft') next = width + step;
    else if (event.key === 'ArrowRight') next = width - step;
    else if (event.key === 'Home') next = PANEL_MIN_WIDTH;
    else if (event.key === 'End') next = max;
    else return;
    event.preventDefault();
    onResize(clamp(next));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no native element (<hr> cannot take focus or a value)
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('resize')}
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={Math.max(PANEL_MIN_WIDTH, max)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      style={{ width: PANEL_DIVIDER_WIDTH }}
      className={cx(
        'group/divider relative z-10 flex shrink-0 cursor-col-resize touch-none items-center justify-center',
        'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-1',
      )}
    >
      <span aria-hidden="true" className="absolute inset-y-0 w-px bg-line" />
      <span
        aria-hidden="true"
        className={cx(
          'relative h-10 w-0.5 rounded-pill bg-transparent transition-colors duration-(--duration-step) ease-(--ease-out)',
          'group-hover/divider:bg-line-strong group-active/divider:bg-accent group-focus-visible/divider:bg-accent',
        )}
      />
    </div>
  );
}
