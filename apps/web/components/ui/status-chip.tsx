import type { SessionStatus } from '@termdock/protocol/client';
import { cx } from './cx.ts';
import { STATE_FILL } from './state.ts';

/**
 * A session's user-facing status: a square state swatch plus the status word in the surface's
 * ink (colour never carries the meaning alone). Used in tabs, pane headers and the phone bar.
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
      className={cx('inline-flex items-center gap-1.5 font-medium text-ink text-xs', className)}
      data-status={status}
    >
      <span
        aria-hidden="true"
        className={cx('size-2 shrink-0 rounded-[1px]', STATE_FILL[status])}
      />
      {label}
    </span>
  );
}
