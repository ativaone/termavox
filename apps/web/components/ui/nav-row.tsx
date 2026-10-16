import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * A sidebar navigation row: icon and label, lit when current (raised fill, ink text, the icon in
 * the accent). The row never moves; it only lights.
 */
export function NavRow({
  icon,
  current = false,
  className,
  children,
  ...props
}: ComponentProps<typeof Link> & { icon: ReactNode; current?: boolean }) {
  return (
    <Link
      aria-current={current ? 'page' : undefined}
      className={cx(
        'relative flex h-9 items-center gap-2.5 rounded-control ps-2.5 pe-2 font-medium text-sm',
        'transition-colors duration-(--duration-step) ease-(--ease-out)',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        current
          ? 'bg-surface-raised text-ink'
          : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
        className,
      )}
      {...props}
    >
      <span className={cx('flex w-4 shrink-0 justify-center', current ? 'text-accent' : '')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

/** The rail's icon-only version of a navigation row (the label becomes its name and tooltip). */
export function NavIcon({
  icon,
  label,
  current = false,
  className,
  ...props
}: Omit<ComponentProps<typeof Link>, 'children'> & {
  icon: ReactNode;
  label: string;
  current?: boolean;
}) {
  return (
    <Link
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      title={label}
      className={cx(
        'flex size-9 items-center justify-center rounded-control',
        'transition-colors duration-(--duration-step) ease-(--ease-out)',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        current
          ? 'bg-surface-raised text-accent'
          : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
        className,
      )}
      {...props}
    >
      {icon}
    </Link>
  );
}
