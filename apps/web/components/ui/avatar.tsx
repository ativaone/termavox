import { cx } from './cx.ts';

/** The first letter of a name, uppercased in its locale (an empty name shows a middle dot). */
export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : '·';
}

/** A round tile with the user's initial: the avatar stand-in in the account row and menu. */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-pill font-bold text-on-accent-fill',
        'bg-[linear-gradient(135deg,#4cc9ff,#8b6cff)]',
        size === 'sm' ? 'size-6 text-2xs' : 'size-7 text-xs',
        className,
      )}
    >
      {initialOf(name)}
    </span>
  );
}
