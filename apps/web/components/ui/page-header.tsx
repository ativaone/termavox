import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/** Heading of a management page on the board: title, one line of context, page actions. */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Small items beside the title (a kind tag). */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="min-w-0 break-words font-semibold text-board-ink text-xl">{title}</h1>
          {meta}
        </div>
        {description ? (
          <p className="max-w-[65ch] text-pretty text-base text-board-ink-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A section heading inside a stock sheet (h2), with an optional trailing action. */
export function SheetHeading({
  id,
  title,
  description,
  action,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={id} className="font-semibold text-ink text-md">
          {title}
        </h2>
        {description ? (
          <p className="max-w-[65ch] text-pretty text-base text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
