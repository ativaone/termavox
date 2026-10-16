'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { groupIntoLanes, laneChanged } from '../../lib/sessions/lanes.ts';
import type { BayData, BaySession } from '../../lib/sessions/types.ts';
import { Lane } from '../ui/lane.tsx';
import { Strip } from '../ui/strip.tsx';
import { formatAgo, formatAgoShort, formatDuration } from './time.ts';

/**
 * Holds the strips on screen and, when fresh data moves a strip to another lane, commits the
 * change inside a view transition: the new edge colour shows at once, then the strip slides to
 * its lane (globals.css, `.strip` transition class). Without the API or under reduced motion,
 * the change simply applies.
 */
function useLaneTransitions(sessions: BaySession[]): BaySession[] {
  const [shown, setShown] = useState(sessions);
  const current = useRef(sessions);
  useEffect(() => {
    if (sessions === current.current) return;
    const before = current.current;
    current.current = sessions;
    const apply = () => setShown(sessions);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (
      typeof document.startViewTransition !== 'function' ||
      reduced ||
      !laneChanged(before, sessions)
    ) {
      apply();
      return;
    }
    document.startViewTransition(() => flushSync(apply));
  }, [sessions]);
  return shown;
}

/** Ticks the clock for uptimes; starts from the server's render time to match hydration. */
function useNow(initial: number, intervalMs = 30_000): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Bay({
  data,
  followedId,
  renderedAt,
  stripHref,
}: {
  data: BayData;
  followedId: string | null;
  renderedAt: number;
  stripHref: (id: string) => string;
}) {
  const t = useTranslations('workspace');
  const td = useTranslations('workspace.duration');
  const locale = useLocale();
  const now = useNow(renderedAt);
  const lanes = groupIntoLanes(useLaneTransitions(data.sessions));

  return (
    <div className="flex flex-col gap-4">
      {lanes.map((lane) => {
        const ended = lane.status === 'ended';
        const count = ended ? data.endedTotal : lane.sessions.length;
        return (
          <Lane
            key={lane.status}
            status={lane.status}
            title={t(`lane.${lane.status}`)}
            count={count}
            countLabel={t('lane.count', { count })}
            collapsible={ended}
            defaultOpen={ended && lane.sessions.some((s) => s.id === followedId)}
            note={
              ended && data.endedTotal > lane.sessions.length
                ? t('lane.endedShown', { shown: lane.sessions.length, total: data.endedTotal })
                : undefined
            }
          >
            {lane.sessions.map((session) => {
              const endedAt = session.endedAt ?? session.createdAt;
              const uptime = formatDuration(now - session.createdAt, td);
              return (
                <li key={session.id}>
                  <Strip
                    href={stripHref(session.id)}
                    label={session.label}
                    target={`${session.user}@${session.host}`}
                    status={session.status}
                    protection={session.protection}
                    protectionLabel={t(`protection.${session.protection ?? 'pending'}`)}
                    time={ended ? formatAgoShort(endedAt, now, td) : uptime}
                    timeLabel={
                      ended
                        ? t('strip.endedAgo', { ago: formatAgo(endedAt, now, locale, 'long') })
                        : t('strip.running', { duration: uptime })
                    }
                    stamp={ended ? t('strip.stamp') : undefined}
                    followed={session.id === followedId}
                    transitionName={`strip-${session.id}`}
                  />
                </li>
              );
            })}
          </Lane>
        );
      })}
    </div>
  );
}
