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
  className,
}: {
  at: number;
  withSeconds?: boolean;
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
  return (
    <time dateTime={iso} title={iso} className={className ?? 'tabular-nums'}>
      {format.format(at)}
      {zone === 'UTC' ? ' UTC' : ''}
    </time>
  );
}
