/** Whole days, hours and minutes in a span of milliseconds (never negative). */
export function durationParts(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}

type DurationKey =
  | 'days'
  | 'hours'
  | 'minutes'
  | 'underMinute'
  | 'agoNow'
  | 'agoMinutes'
  | 'agoHours'
  | 'agoDays';
export type DurationTranslator = (key: DurationKey, values?: Record<string, number>) => string;

/** Compact uptime: "8d 11h", "3h 42m", "42m", "<1m" (units from the message catalog). */
export function formatDuration(ms: number, t: DurationTranslator): string {
  const { days, hours, minutes } = durationParts(ms);
  if (days > 0) return t('days', { days, hours });
  if (hours > 0) return t('hours', { hours, minutes });
  if (minutes > 0) return t('minutes', { minutes });
  return t('underMinute');
}

/** Compact age for a session row's time cell, one unit: "35m ago", "2h ago", "3d ago". */
export function formatAgoShort(at: number, now: number, t: DurationTranslator): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t('agoNow');
  if (minutes < 60) return t('agoMinutes', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('agoHours', { hours });
  return t('agoDays', { days: Math.floor(hours / 24) });
}

/** "2 hours ago" (long, for assistive tech) or narrow, picking the unit by magnitude. */
export function formatAgo(
  at: number,
  now: number,
  locale: string,
  style: 'narrow' | 'long' = 'narrow',
): string {
  const format = new Intl.RelativeTimeFormat(locale, { style, numeric: 'auto' });
  const minutes = Math.round((at - now) / 60_000);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}
