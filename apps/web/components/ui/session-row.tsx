import type { Protection, SessionStatus } from '@termdock/protocol/client';
import Link from 'next/link';
import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import {
  ShieldIcon,
  ShieldOffIcon,
  ShieldOutlineIcon,
  ShieldPendingIcon,
} from '../icons/index.tsx';
import { cx } from './cx.ts';
import { StateLamp } from './status-chip.tsx';

export interface SessionRowProps {
  href: string;
  label: string;
  /** `user@host`. */
  target: string;
  status: SessionStatus;
  protection: Protection | null;
  /** Localized protection explanation (tooltip and screen-reader text). */
  protectionLabel: string;
  /** Uptime ("3h 42m") or, for ended sessions, how long ago it ended ("2h ago"). */
  time: string;
  /** Full sentence for assistive tech ("Running for 3 hours 42 minutes"). */
  timeLabel: string;
  /** The session this browser follows: lit by the reading light (fill and ring), never moved. */
  followed?: boolean;
  /** Small word for ended sessions ("Ended"). */
  stamp?: string;
  /** Stable view-transition name so a group change slides the row (signature move). */
  transitionName?: string;
  /** Follows the session in place (a plain click; modified clicks keep the link's default). */
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  /** The row's actions control, drawn in its own trailing cell. */
  menu?: ReactNode;
  className?: string;
}

/** The protection mark (decorative: the caller carries the `protection.*` words beside it). */
export function ProtectionMark({ protection }: { protection: Protection | null }) {
  if (protection === 'tmux-control') return <ShieldIcon size={15} />;
  if (protection === 'tmux-normal') return <ShieldOutlineIcon size={15} />;
  if (protection === 'none') return <ShieldOffIcon size={15} className="text-ink-muted" />;
  return <ShieldPendingIcon size={15} className="text-ink-muted" />;
}

/** The light that marks the followed session; it travels between rows in a view transition. */
export function FollowedLight({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'pointer-events-none absolute inset-0 rounded-row bg-accent-soft shadow-light',
        '[view-transition-name:followed-light]',
        className,
      )}
    />
  );
}

/**
 * A session row: state lamp, label over `user@host`, protection mark, time, and the actions cell.
 * The row is one link; the followed row carries the reading light (a fill and a cyan ring) and
 * keeps exactly the place and size of its siblings.
 */
export function SessionRow({
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
  onClick,
  onContextMenu,
  menu,
  className,
}: SessionRowProps) {
  const ended = status === 'ended';
  const style = transitionName
    ? ({ viewTransitionName: transitionName, viewTransitionClass: 'session-row' } as CSSProperties)
    : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the context menu mirrors the actions button, which stays the accessible way in
    <div
      data-status={status}
      style={style}
      onContextMenu={onContextMenu}
      className={cx(
        'group/row relative grid h-12 items-stretch rounded-row',
        menu ? 'grid-cols-[minmax(0,1fr)_1.75rem]' : 'grid-cols-[minmax(0,1fr)]',
        'transition-colors duration-(--duration-step) ease-(--ease-out)',
        'has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-1 has-[a:focus-visible]:outline-focus',
        !followed && 'hover:bg-surface-raised',
        className,
      )}
    >
      {followed ? <FollowedLight /> : null}
      <Link
        href={href}
        scroll={false}
        onClick={onClick}
        aria-current={followed ? 'true' : undefined}
        className="relative grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto_auto] items-center gap-x-2.5 ps-2.5 pe-1 outline-none"
      >
        <StateLamp status={status} />
        <span className="flex min-w-0 flex-col justify-center gap-px">
          <span
            className={cx(
              'truncate font-semibold text-[0.8125rem] leading-4',
              ended ? 'text-ink-muted' : 'text-ink',
            )}
          >
            {label}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-ink-muted text-xs leading-4">
            {stamp ? (
              <span className="shrink-0 rounded-pill bg-surface-raised px-1.5 font-semibold text-2xs leading-4">
                {stamp}
              </span>
            ) : null}
            <span className="truncate">{target}</span>
          </span>
        </span>
        <span
          className={cx('flex items-center justify-center', ended ? 'text-ink-muted' : 'text-ink')}
          title={protectionLabel}
        >
          <ProtectionMark protection={protection} />
          <span className="sr-only">{protectionLabel}</span>
        </span>
        <span className="flex min-w-10 items-center justify-end font-data font-medium text-ink-muted text-xs">
          <span aria-hidden="true" className="whitespace-nowrap">
            {time}
          </span>
          <span className="sr-only">{timeLabel}</span>
        </span>
      </Link>
      {menu ? <span className="relative flex items-center justify-center pe-1">{menu}</span> : null}
    </div>
  );
}

/** Two letters that stand for a label in the rail ("api-prod" → "AP", "psql" → "PS", "web-1" → "W1"). */
export function initialsOf(label: string): string {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const first = words[0] ?? '';
  const second = words[1] ?? '';
  const letters = second
    ? `${[...first][0] ?? ''}${[...second][0] ?? ''}`
    : [...first].slice(0, 2).join('');
  return letters.toLocaleUpperCase() || '··';
}

/**
 * The rail's compact session tile: initials with the state lamp in its corner. The accessible
 * name carries the label, the target and the status word; the tooltip shows the label and target.
 */
export function SessionTile({
  href,
  label,
  target,
  status,
  statusLabel,
  followed = false,
  onClick,
  onContextMenu,
  menu,
}: {
  href: string;
  label: string;
  target: string;
  status: SessionStatus;
  statusLabel: string;
  followed?: boolean;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  /** The tile's actions control, shown at its corner on hover or focus. */
  menu?: ReactNode;
}) {
  const link = (
    <Link
      href={href}
      scroll={false}
      onClick={onClick}
      data-status={status}
      aria-current={followed ? 'true' : undefined}
      aria-label={`${label}, ${target}, ${statusLabel}`}
      title={`${label} · ${target}`}
      className={cx(
        'relative flex size-9 items-center justify-center rounded-control font-semibold text-xs',
        'transition-colors duration-(--duration-step) ease-(--ease-out)',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        followed ? 'text-ink' : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
        status === 'ended' && !followed && 'text-ink-faint',
      )}
    >
      {followed ? <FollowedLight className="rounded-control" /> : null}
      <span aria-hidden="true" className="relative">
        {initialsOf(label)}
      </span>
      <StateLamp status={status} size="sm" className="absolute end-1 bottom-1" />
    </Link>
  );
  if (!menu) return link;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the context menu mirrors the actions button, which stays the accessible way in
    <div onContextMenu={onContextMenu} className="group/tile relative" data-status={status}>
      {link}
      <span
        className={cx(
          'absolute -end-1 -top-1 rounded-sm bg-surface-solid opacity-0 transition-opacity duration-(--duration-step) ease-(--ease-out)',
          'group-hover/tile:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100',
        )}
      >
        {menu}
      </span>
    </div>
  );
}
