import type { SessionStatus } from '@termdock/protocol/client';
import { type ReactNode, useId } from 'react';
import { ChevronRightIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';
import { StateLamp } from './status-chip.tsx';

export interface SessionGroupProps {
  status: SessionStatus;
  title: string;
  count: number;
  /** Screen-reader count ("3 sessions"). */
  countLabel: string;
  /** Collapsible group (Ended): a native disclosure, closed unless `defaultOpen`. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Small print under the header (e.g. "Latest 20 of 57"). */
  note?: string;
  /** Under the rows, inside the group (e.g. "Remove all ended…"). */
  footer?: ReactNode;
  children: ReactNode;
}

function GroupTitle({ status, title }: { status: SessionStatus; title: string }) {
  return (
    <span className="flex items-center gap-2 font-semibold text-ink-muted text-xs">
      <StateLamp status={status} size="sm" />
      {title}
    </span>
  );
}

function GroupCount({
  count,
  label,
  attention = false,
}: {
  count: number;
  label: string;
  attention?: boolean;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cx(
          'min-w-5 rounded-pill px-1.5 text-center font-data font-semibold text-2xs leading-4.5',
          attention ? 'bg-attention text-on-accent' : 'bg-surface-raised text-ink-muted',
        )}
      >
        {count}
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
}

/** A state group of the session list: a header with the lamp, the state word and a count, then its rows. */
export function SessionGroup({
  status,
  title,
  count,
  countLabel,
  collapsible = false,
  defaultOpen = false,
  note,
  footer,
  children,
}: SessionGroupProps) {
  const headingId = useId();
  const attention = status === 'action_required';
  const body = (
    <>
      {note ? <p className="px-2.5 pb-1 text-ink-muted text-xs">{note}</p> : null}
      <ul className="flex flex-col gap-0.5">{children}</ul>
      {footer}
    </>
  );
  if (collapsible) {
    return (
      <details className="group/section flex flex-col" open={defaultOpen}>
        <summary
          className={cx(
            'flex h-8 cursor-pointer list-none items-center justify-between gap-2 rounded-sm px-2.5',
            'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-details-marker]:hidden',
          )}
        >
          <h2 id={headingId} className="flex items-center gap-1.5">
            <GroupTitle status={status} title={title} />
            <ChevronRightIcon
              size={14}
              className="text-ink-muted transition-transform duration-(--duration-move) ease-(--ease-out) group-open/section:rotate-90"
            />
          </h2>
          <GroupCount count={count} label={countLabel} />
        </summary>
        {/* Indented under a guide line from the chevron: the rows read as inside the group. */}
        <div className="ms-3.5 mt-1 flex flex-col gap-0.5 border-line border-s ps-1.5">{body}</div>
      </details>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <div className="flex h-8 items-center justify-between gap-2 px-2.5">
        <h2 id={headingId}>
          <GroupTitle status={status} title={title} />
        </h2>
        <GroupCount count={count} label={countLabel} attention={attention} />
      </div>
      {body}
    </section>
  );
}
