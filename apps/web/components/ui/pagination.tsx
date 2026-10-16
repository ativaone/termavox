import { ChevronLeftIcon, ChevronRightIcon } from '../icons/index.tsx';
import { ButtonLink } from './button.tsx';
import { cx } from './cx.ts';

/** Previous / page n of m / next, as plain links (shareable, no client state). */
export function Pagination({
  page,
  pageCount,
  hrefFor,
  labels,
  className,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
  labels: { nav: string; previous: string; next: string; status: string };
  className?: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav
      aria-label={labels.nav}
      className={cx('flex items-center justify-between gap-3', className)}
    >
      {page > 1 ? (
        <ButtonLink
          href={hrefFor(page - 1)}
          variant="secondary"
          size="sm"
          icon={<ChevronLeftIcon size={16} />}
        >
          {labels.previous}
        </ButtonLink>
      ) : (
        <span />
      )}
      <p className="text-ink-muted text-sm tabular-nums">{labels.status}</p>
      {page < pageCount ? (
        <ButtonLink href={hrefFor(page + 1)} variant="secondary" size="sm">
          {labels.next}
          <ChevronRightIcon size={16} />
        </ButtonLink>
      ) : (
        <span />
      )}
    </nav>
  );
}

export const PAGE_SIZE = 25;

/**
 * Runs a paginated read for `?page=` (1-based). A page past the end falls back to the last one,
 * so a stale link never shows an empty sheet.
 */
export function paginate<T>(
  value: string | string[] | undefined,
  read: (page: { limit: number; offset: number }) => { rows: T[]; total: number },
  size = PAGE_SIZE,
): { rows: T[]; total: number; page: number; pageCount: number } {
  const raw = typeof value === 'string' ? Number.parseInt(value, 10) : 1;
  let page = Number.isFinite(raw) && raw > 0 ? raw : 1;
  let result = read({ limit: size, offset: (page - 1) * size });
  const pageCount = Math.max(1, Math.ceil(result.total / size));
  if (page > pageCount) {
    page = pageCount;
    result = read({ limit: size, offset: (page - 1) * size });
  }
  return { ...result, page, pageCount };
}
