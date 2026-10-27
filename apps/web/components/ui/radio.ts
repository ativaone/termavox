import { cx } from './cx.ts';

/**
 * A native radio drawn like Checkbox: an empty well at rest, the accent with a dark centre when
 * chosen, a dim disc when disabled. Drawn rather than left to the browser so it matches the
 * 20 px checkbox and the accent.
 */
export function radioClasses(size: 'md' | 'sm' = 'md', className?: string): string {
  return cx(
    size === 'md' ? 'size-5' : 'size-4',
    'shrink-0 cursor-pointer appearance-none rounded-pill border border-line-strong bg-field',
    'transition-[background-color,border-color,box-shadow] duration-(--duration-step) ease-(--ease-out)',
    'hover:border-line-hover checked:border-accent checked:bg-accent',
    size === 'md'
      ? 'checked:shadow-[inset_0_0_0_4px_var(--color-ground)]'
      : 'checked:shadow-[inset_0_0_0_3px_var(--color-ground)]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:cursor-not-allowed disabled:border-line disabled:bg-surface',
    className,
  );
}

/** A choice card around a radio: a bordered row that lights with the accent when chosen. */
export function choiceCardClasses(chosen: boolean, className?: string): string {
  return cx(
    'flex cursor-pointer rounded-control border transition-colors duration-(--duration-step) ease-(--ease-out)',
    'has-focus-visible:outline-2 has-focus-visible:outline-focus has-focus-visible:outline-offset-2',
    chosen ? 'border-accent-ring bg-accent-soft' : 'border-line hover:bg-surface-raised',
    className,
  );
}
