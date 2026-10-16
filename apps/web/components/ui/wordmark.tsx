import { cx } from './cx.ts';

/**
 * The Termdock mark: a rounded tile lit from cyan to violet with a prompt glyph, beside the name
 * in sentence case. `tile` alone is the rail's and the phone header's mark.
 */
export function BrandTile({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0', className)}
    >
      <defs>
        <linearGradient id="termdock-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4cc9ff" />
          <stop offset="1" stopColor="#8b6cff" />
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="8" fill="url(#termdock-tile)" />
      <path
        d="M8.5 9.5 13.5 14l-5 4.5M15 19h5"
        fill="none"
        stroke="#0a1226"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5 text-ink', className)}>
      <BrandTile />
      <span className="font-semibold text-md tracking-[-0.01em]">Termdock</span>
    </span>
  );
}
