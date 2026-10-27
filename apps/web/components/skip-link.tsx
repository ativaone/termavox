/** First focusable element of every page: jumps past the chrome to the main region. */
export function SkipLink({ label, target = 'main' }: { label: string; target?: string }) {
  return (
    <a
      href={`#${target}`}
      className="sr-only rounded-control bg-accent-fill px-3 py-2 font-semibold text-on-accent-fill text-sm focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50"
    >
      {label}
    </a>
  );
}
