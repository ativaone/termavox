/**
 * Sizes, speeds, percentages and modification dates as the file panel prints them, in the UI's
 * locale (plan §5.12). Framework-free; every value is meant for tabular figures.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
const STEP = 1024;

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string | undefined, digits: number): Intl.NumberFormat {
  const key = `${locale ?? ''}|${digits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0,
    });
    numberFormats.set(key, format);
  }
  return format;
}

/**
 * `412 B`, `3.1 KB`, `148 MB`: binary steps (as `ls -h` and the browser's download list count),
 * one decimal below 10 in a unit, none above.
 */
export function formatSize(bytes: number, locale?: string): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit++;
  }
  // 1023.6 KB would print as "1024 KB": step up instead.
  if (unit > 0 && unit < UNITS.length - 1 && Math.round(value) >= STEP) {
    value /= STEP;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${numberFormat(locale, digits).format(value)} ${UNITS[unit]}`;
}

/** `3.1 MB/s`. */
export function formatSpeed(bytesPerSecond: number, locale?: string): string {
  return `${formatSize(bytesPerSecond, locale)}/s`;
}

/** Whole percent of `done` out of `total` (0 when the total is 0 and nothing is due). */
export function percentOf(done: number, total: number): number {
  if (total <= 0) return done > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * A modification time, short: "today 09:15" for today (the locale's own word), day, month and
 * time within this year, day, month and year before (or for a time in the future).
 */
export function formatModified(mtime: number, now: number, locale?: string): string {
  const date = new Date(mtime);
  const today = new Date(now);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  if (sameDay(date, today)) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'day');
    return `${word} ${time.format(date)}`;
  }
  if (date.getFullYear() === today.getFullYear() && mtime <= now) {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** The full time, for a tooltip. */
export function formatFullTime(mtime: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
    new Date(mtime),
  );
}
