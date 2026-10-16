'use client';

import { useLocale, useTranslations } from 'next-intl';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { groupIntoLanes, laneChanged } from '../../lib/sessions/lanes.ts';
import type { BayData, BaySession } from '../../lib/sessions/types.ts';
import { Lane } from '../ui/lane.tsx';
import { Strip } from '../ui/strip.tsx';
import { StripMenu, type StripMenuActions } from './strip-menu.tsx';
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
    const transition = document.startViewTransition(() => flushSync(apply));
    // A transition skipped by a newer one (or a hidden page) still applies the change.
    transition.ready.catch(() => {});
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

/** A plain primary click (modified clicks keep the link's default: a new browser tab…). */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function Bay({
  data,
  followedId,
  renderedAt,
  stripHref,
  onFollow,
  menuActions,
  desktop = true,
}: {
  data: BayData;
  followedId: string | null;
  renderedAt: number;
  stripHref: (id: string) => string;
  /** Follows a session in place instead of navigating. */
  onFollow?: (sessionId: string) => void;
  /** The actions of a strip's menu; no menu without it. */
  menuActions?: (session: BaySession) => StripMenuActions;
  /** Desktop menus also open tabs and splits. */
  desktop?: boolean;
}) {
  const t = useTranslations('workspace');
  const td = useTranslations('workspace.duration');
  const locale = useLocale();
  const now = useNow(renderedAt);
  const lanes = groupIntoLanes(useLaneTransitions(data.sessions));
  // Right-click on a strip opens its actions menu.
  const [menuSignal, setMenuSignal] = useState<{ id: string; n: number } | null>(null);

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
                    onClick={
                      onFollow
                        ? (event) => {
                            if (!isPlainClick(event)) return;
                            event.preventDefault();
                            onFollow(session.id);
                          }
                        : undefined
                    }
                    onContextMenu={
                      menuActions
                        ? (event) => {
                            event.preventDefault();
                            setMenuSignal((m) => ({ id: session.id, n: (m?.n ?? 0) + 1 }));
                          }
                        : undefined
                    }
                    menu={
                      menuActions ? (
                        <StripMenu
                          session={session}
                          desktop={desktop}
                          actions={menuActions(session)}
                          openSignal={menuSignal?.id === session.id ? menuSignal.n : 0}
                        />
                      ) : undefined
                    }
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
