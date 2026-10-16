import { cx } from './cx.ts';

/**
 * A native radio drawn in the surface's tokens, like Checkbox: an empty writing-field ring at
 * rest, the primary material with a field-coloured centre when chosen. The browser default draws
 * a disabled unchecked radio as a dark disc, which reads as "selected" on buff stock.
 */
export function radioClasses(size: 'md' | 'sm' = 'md', className?: string): string {
  return cx(
    size === 'md' ? 'size-5' : 'size-4',
    'shrink-0 cursor-pointer appearance-none rounded-full border border-rule-strong bg-field',
    'transition-[background-color,border-color,box-shadow] duration-(--duration-step) ease-linear',
    'hover:border-ink-muted checked:border-primary checked:bg-primary',
    size === 'md'
      ? 'checked:shadow-[inset_0_0_0_4px_var(--field)]'
      : 'checked:shadow-[inset_0_0_0_3px_var(--field)]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:cursor-not-allowed disabled:border-rule disabled:bg-disabled',
    className,
  );
}
