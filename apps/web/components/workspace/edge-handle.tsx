'use client';

import { type KeyboardEvent, type PointerEvent, useRef } from 'react';
import { cx } from '../ui/cx.ts';

/** A key on a vertical edge: one step left or right, or the edge to its left or right limit. */
export type EdgeKey = 'back' | 'forward' | 'home' | 'end';

const KEYS: Readonly<Record<string, EdgeKey>> = {
  ArrowLeft: 'back',
  ArrowRight: 'forward',
  Home: 'home',
  End: 'end',
};

/**
 * A draggable vertical edge drawn like the split dividers: an 8 px strip whose grip shows on
 * hover and turns cyan while dragged or focused; `ruled` adds the file panel divider's
 * always-visible 1 px rule. The owner keeps the size: the handle reports the press, the
 * pointer's travel in CSS px, the release, the keys and a double-click (back to the default).
 */
export function EdgeHandle({
  label,
  value,
  min,
  max,
  ruled = false,
  className,
  onPress,
  onDrag,
  onRelease,
  onKey,
  onReset,
}: {
  label: string;
  /** The edge's position for assistive technology, in the owner's unit. */
  value: number;
  min: number;
  max: number;
  ruled?: boolean;
  className?: string;
  onPress(handle: HTMLElement): void;
  onDrag(dx: number): void;
  onRelease(): void;
  onKey(key: EdgeKey, large: boolean, handle: HTMLElement): void;
  onReset(): void;
}) {
  const start = useRef<number | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = event.clientX;
    onPress(event.currentTarget);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current !== null) onDrag(event.clientX - start.current);
  };
  const finish = () => {
    if (start.current === null) return;
    start.current = null;
    onRelease();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = KEYS[event.key];
    if (!key) return;
    event.preventDefault();
    onKey(key, event.shiftKey, event.currentTarget);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no native element (<hr> cannot take focus or a value)
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(Math.max(min, max))}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cx(
        'group/divider z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center',
        'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-1',
        className,
      )}
    >
      {ruled ? <span aria-hidden="true" className="absolute inset-y-0 w-px bg-line" /> : null}
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
