import type { SessionStatus } from '@termavox/protocol/client';
import { type ComponentType, type ReactNode, useEffect, useId, useRef } from 'react';
import {
  AlertIcon,
  ChevronRightIcon,
  ConnectingIcon,
  type IconProps,
  PlugIcon,
  PlugOffIcon,
  PowerIcon,
  RestoreIcon,
  RetryIcon,
} from '../icons/index.tsx';
import { cx } from './cx.ts';

/** Each state's mark in its group header: neutral ink, since colour belongs to the rows' lamps. */
const GROUP_ICON: Record<SessionStatus, ComponentType<IconProps>> = {
  action_required: AlertIcon,
  disconnected: PlugOffIcon,
  reconnecting: RetryIcon,
  restoring: RestoreIcon,
  connecting: ConnectingIcon,
  connected: PlugIcon,
  ended: PowerIcon,
};

export interface SessionGroupProps {
  status: SessionStatus;
  title: string;
  count: number;
  /** Screen-reader count ("3 sessions"). */
  countLabel: string;
  /** The followed session, when it is in this group: each new one opens a closed group, so the lit row shows. */
  followedHere?: string | null;
  /** Small print under the header (e.g. "Latest 20 of 57"). */
  note?: string;
  /** Under the rows, inside the group (e.g. "Remove all ended…"). */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * A state group of the session list, one shape for every state: a native disclosure, open from
 * the start, whose header is a filled bar that ranks above its rows: the chevron over their lamps,
 * the state's icon and word over their labels, and the count at the end. Closing it lasts until
 * the list is drawn again.
 */
export function SessionGroup({
  status,
  title,
  count,
  countLabel,
  followedHere = null,
  note,
  footer,
  children,
}: SessionGroupProps) {
  const headingId = useId();
  const details = useRef<HTMLDetailsElement>(null);
  const attention = status === 'action_required';
  const Icon = GROUP_ICON[status];

  useEffect(() => {
    if (followedHere && details.current) details.current.open = true;
  }, [followedHere]);

  return (
    <details ref={details} open aria-labelledby={headingId} className="group/section flex flex-col">
      <summary
        className={cx(
          // The same columns as a session row, so the header lines up with the rows under it.
          'grid h-9 cursor-pointer list-none grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-control bg-surface-pressed px-2.5',
          // Already on the strongest fill, so the pointer draws a line instead of a lighter fill.
          'hover:outline-1 hover:outline-line-strong hover:-outline-offset-1',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRightIcon
          size={14}
          className="justify-self-center text-ink-muted transition-transform duration-(--duration-move) ease-(--ease-out) group-open/section:rotate-90"
        />
        <h2
          id={headingId}
          className="flex min-w-0 items-center gap-2 font-semibold text-base text-ink"
        >
          <Icon size={16} className="shrink-0" />
          <span className="truncate">{title}</span>
        </h2>
        <span
          aria-hidden="true"
          className={cx(
            'min-w-5 rounded-pill px-1.5 text-center font-data font-semibold text-2xs leading-4.5',
            attention ? 'bg-attention text-on-accent' : 'bg-ground text-ink-muted',
          )}
        >
          {count}
        </span>
        <span className="sr-only">{countLabel}</span>
      </summary>
      <div className="mt-1 flex flex-col gap-0.5">
        {note ? <p className="px-2.5 pb-1 text-ink-muted text-xs">{note}</p> : null}
        <ul className="flex flex-col gap-0.5">{children}</ul>
        {footer}
      </div>
    </details>
  );
}
