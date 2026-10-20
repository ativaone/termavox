import type { SessionStatus } from '@termavox/protocol/client';
import { cx } from './cx.ts';
import { STATE_FILL } from './state.ts';

/**
 * A session's user-facing status: a state lamp beside the status word in ink (colour never
 * carries the meaning alone). Used in tabs, pane captions, the palette and the phone header.
 */
export function StatusChip({
  status,
  label,
  className,
}: {
  status: SessionStatus;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 font-medium text-ink-muted text-xs',
        className,
      )}
      data-status={status}
    >
      <span aria-hidden="true" className={cx('size-2 shrink-0 rounded-pill', STATE_FILL[status])} />
      {label}
    </span>
  );
}

/** The state lamp alone (decorative: callers put the state word beside it). */
export function StateLamp({
  status,
  size = 'md',
  className,
}: {
  status: SessionStatus;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block shrink-0 rounded-pill',
        size === 'sm' ? 'size-1.5' : 'size-2',
        STATE_FILL[status],
        className,
      )}
    />
  );
}
