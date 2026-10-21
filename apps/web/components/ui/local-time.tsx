'use client';

import { useLocale } from 'next-intl';
import { useEffect, useState } from 'react';

/**
 * An absolute date and time. The server renders it in UTC (it cannot know the viewer's zone);
 * after hydration it switches to the browser's own time zone. Tabular figures throughout.
 */
export function LocalTime({
  at,
  withSeconds = false,
  splitTime = false,
  className,
}: {
  at: number;
  withSeconds?: boolean;
  /**
   * In a narrow table cell the text wraps only between the date and the time (two lines at
   * most), never inside either: "21 de out. de 2026," over "02:23".
   */
  splitTime?: boolean;
  className?: string;
}) {
  const locale = useLocale();
  const [zone, setZone] = useState<string>('UTC');
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: withSeconds ? 'medium' : 'short',
    timeZone: zone,
  });
  const iso = new Date(at).toISOString();
  const suffix = zone === 'UTC' ? ' UTC' : '';
  const parts = splitTime ? splitDateTime(format, at) : null;
  return (
    <time dateTime={iso} title={iso} className={className ?? 'tabular-nums'}>
      {parts ? (
        <>
          <span className="whitespace-nowrap">{parts.date}</span>{' '}
          <span className="whitespace-nowrap">
            {parts.time}
            {suffix}
          </span>
        </>
      ) : (
        <>
          {format.format(at)}
          {suffix}
        </>
      )}
    </time>
  );
}

/**
 * The formatted text cut where the locale's pattern puts a space between the date and the time
 * ("Oct 21, 2026, 2:23 AM" → "Oct 21, 2026," and "2:23 AM"); null when it has no such space.
 * The parts only say where to cut: the text is `format()`'s, which the server and the browser
 * agree on, while their `formatToParts` may not (Node keeps U+202F before "AM", Chromium a space),
 * and a different character fails hydration.
 */
function splitDateTime(
  format: Intl.DateTimeFormat,
  at: number,
): { date: string; time: string } | null {
  const parts = format.formatToParts(at);
  const hour = parts.findIndex((part) => part.type === 'hour');
  const joint = parts[hour - 1];
  if (hour < 1 || joint?.type !== 'literal' || !/\s$/u.test(joint.value)) return null;
  const text = format.format(at);
  const cut = parts.slice(0, hour).reduce((length, part) => length + part.value.length, 0);
  if (text.length !== parts.reduce((length, part) => length + part.value.length, 0)) return null;
  return { date: text.slice(0, cut).trimEnd(), time: text.slice(cut) };
}
