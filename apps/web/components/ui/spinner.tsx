import { cx } from './cx.ts';

/**
 * Inline progress mark for controls that are working (a submitting button). Content areas use
 * Skeleton instead. Under reduced motion it stays a still arc.
 */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0 animate-spin motion-reduce:animate-none', className)}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Static placeholder block in the surface's hover tone; no shimmer (state, not decoration). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cx('block rounded-strip bg-surface-hover', className)} />
  );
}
