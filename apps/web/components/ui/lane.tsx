import type { SessionStatus } from '@termdock/protocol/client';
import { type ReactNode, useId } from 'react';
import { ChevronRightIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';
import { STATE_FILL } from './state.ts';

export interface LaneProps {
  status: SessionStatus;
  title: string;
  count: number;
  /** Screen-reader count ("3 sessions"). */
  countLabel: string;
  /** Collapsible lane (Ended): a native disclosure, closed unless `defaultOpen`. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Small print under the header (e.g. "Latest 20 of 57"). */
  note?: string;
  children: ReactNode;
}

function LaneTitle({ status, title }: { status: SessionStatus; title: string }) {
  return (
    <span className="flex items-center gap-2 font-bold font-strip-wide text-2xs text-ink-muted">
      <span aria-hidden="true" className={cx('size-1.5 rounded-[1px]', STATE_FILL[status])} />
      {title}
    </span>
  );
}

function LaneCount({ count, label }: { count: number; label: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="min-w-6 rounded-[3px] bg-board-0 px-1.5 text-center font-semibold text-ink-muted text-xs leading-5 tabular-nums"
      >
        {count}
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
}

/** A state lane of the bay: header with the state word and count, then its strips. */
export function Lane({
  status,
  title,
  count,
  countLabel,
  collapsible = false,
  defaultOpen = false,
  note,
  children,
}: LaneProps) {
  const headingId = useId();
  const body = (
    <>
      {note ? <p className="px-1 pb-1 text-ink-muted text-xs">{note}</p> : null}
      <ul className="flex flex-col gap-1.5">{children}</ul>
    </>
  );
  if (collapsible) {
    return (
      <details className="group/lane flex flex-col" open={defaultOpen}>
        <summary
          className={cx(
            'flex h-8 cursor-pointer list-none items-center justify-between gap-2 rounded-control px-1',
            'transition-colors duration-(--duration-step) ease-linear hover:bg-quiet-hover',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-details-marker]:hidden',
          )}
        >
          <h2 id={headingId} className="flex items-center gap-1">
            <ChevronRightIcon
              size={14}
              className="text-ink-muted transition-transform duration-(--duration-move) ease-out group-open/lane:rotate-90"
            />
            <LaneTitle status={status} title={title} />
          </h2>
          <LaneCount count={count} label={countLabel} />
        </summary>
        <div className="flex flex-col gap-1.5 pt-1.5">{body}</div>
      </details>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <div className="flex h-8 items-center justify-between gap-2 px-1">
        <h2 id={headingId}>
          <LaneTitle status={status} title={title} />
        </h2>
        <LaneCount count={count} label={countLabel} />
      </div>
      {body}
    </section>
  );
}
