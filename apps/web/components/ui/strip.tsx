import type { Protection, SessionStatus } from '@termdock/protocol/client';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import {
  ShieldIcon,
  ShieldOffIcon,
  ShieldOutlineIcon,
  ShieldPendingIcon,
} from '../icons/index.tsx';
import { cx } from './cx.ts';
import { STATE_FILL } from './state.ts';

export interface StripProps {
  href: string;
  label: string;
  /** `user@host`. */
  target: string;
  status: SessionStatus;
  protection: Protection | null;
  /** Localized protection explanation (tooltip and screen-reader text). */
  protectionLabel: string;
  /** Uptime ("3h 42m") or, for ended strips, how long ago it ended ("2h ago"). */
  time: string;
  /** Full sentence for assistive tech ("Running for 3 hours 42 minutes"). */
  timeLabel: string;
  /** The session this browser follows: the strip is cocked out of the row, as on a real board. */
  followed?: boolean;
  /** Stamp text for ended strips ("Ended"). */
  stamp?: string;
  /** Stable view-transition name so a lane change slides the strip (signature move). */
  transitionName?: string;
  className?: string;
}

function ProtectionMark({ protection }: { protection: Protection | null }) {
  if (protection === 'tmux-control') return <ShieldIcon size={16} />;
  if (protection === 'tmux-normal') return <ShieldOutlineIcon size={16} />;
  if (protection === 'none') return <ShieldOffIcon size={16} className="text-ink-muted" />;
  return <ShieldPendingIcon size={16} className="text-ink-faint" />;
}

/**
 * A session strip: 4 px state edge, label in condensed caps over `user@host`, protection cell
 * and time cell divided by hairline rules. The whole strip is one link.
 */
export function Strip({
  href,
  label,
  target,
  status,
  protection,
  protectionLabel,
  time,
  timeLabel,
  followed = false,
  stamp,
  transitionName,
  className,
}: StripProps) {
  const ended = status === 'ended';
  const style = transitionName
    ? ({ viewTransitionName: transitionName, viewTransitionClass: 'strip' } as CSSProperties)
    : undefined;
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={followed ? 'true' : undefined}
      data-status={status}
      style={style}
      className={cx(
        'surface-stock group/strip grid h-12 grid-cols-[4px_minmax(0,1fr)_2.25rem_4.5rem] items-stretch overflow-hidden',
        'rounded-strip text-ink shadow-strip',
        'transition-[translate,background-color,box-shadow] duration-(--duration-move) ease-out',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-board',
        'active:translate-y-px',
        followed
          ? 'translate-x-(--strip-offset) bg-stock-followed shadow-strip-followed'
          : ended
            ? 'bg-stock-ended hover:bg-stock'
            : 'bg-stock hover:bg-stock-hover',
        className,
      )}
    >
      <span aria-hidden="true" className={STATE_FILL[status]} />
      <span className="flex min-w-0 flex-col justify-center gap-0.5 ps-2.5 pe-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold font-strip text-strip">{label}</span>
          {stamp ? (
            <span className="shrink-0 rounded-[2px] border border-rule-strong px-1 font-bold font-strip-wide text-[0.625rem] text-ink-muted leading-3.5">
              {stamp}
            </span>
          ) : null}
        </span>
        <span className="truncate text-ink-muted text-xs">{target}</span>
      </span>
      <span
        className="flex items-center justify-center border-rule border-s text-ink"
        title={protectionLabel}
      >
        <ProtectionMark protection={protection} />
        <span className="sr-only">{protectionLabel}</span>
      </span>
      <span className="flex items-center justify-end border-rule border-s pe-2.5 ps-1.5 font-medium text-ink text-sm tabular-nums">
        <span aria-hidden="true" className="truncate">
          {time}
        </span>
        <span className="sr-only">{timeLabel}</span>
      </span>
    </Link>
  );
}
