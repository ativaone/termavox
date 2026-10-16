import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * An empty state that teaches the next step: what this place is for, and the one action that
 * fills it. Sits on whatever surface holds it (usually a Panel inside the pane area).
 */
export function EmptyState({
  icon,
  title,
  titleId,
  body,
  action,
  children,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  titleId?: string;
  body?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-start gap-4', className)}>
      {icon ? (
        <span className="inline-flex size-11 items-center justify-center rounded-row bg-accent-soft text-accent">
          {icon}
        </span>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <h2 id={titleId} className="font-semibold text-ink text-xl tracking-[-0.01em]">
          {title}
        </h2>
        {body ? <p className="max-w-[52ch] text-pretty text-base text-ink-muted">{body}</p> : null}
      </div>
      {children}
      {action}
    </div>
  );
}
