'use client';

import { useLocale, useTranslations } from 'next-intl';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { groupIntoLanes, laneChanged } from '../../lib/sessions/lanes.ts';
import type { BayData, BaySession } from '../../lib/sessions/types.ts';
import { SessionGroup } from '../ui/session-group.tsx';
import { SessionRow, SessionTile } from '../ui/session-row.tsx';
import { SessionMenu, type SessionMenuActions } from './session-menu.tsx';
import { formatAgo, formatAgoShort, formatDuration } from './time.ts';

/**
 * Holds the rows on screen and, when fresh data moves a session to another group, commits the
 * change inside a view transition: the lamp recolours at once, then the row slides to its group
 * (globals.css, `.session-row` transition class). Without the API or under reduced motion, the
 * change simply applies.
 */
function useGroupTransitions(sessions: BaySession[]): BaySession[] {
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

export interface SessionListProps {
  data: BayData;
  followedId: string | null;
  renderedAt: number;
  sessionHref: (id: string) => string;
  /** Follows a session in place instead of navigating. */
  onFollow?: (sessionId: string) => void;
  /** The actions of a row's menu; no menu without it. */
  menuActions?: (session: BaySession) => SessionMenuActions;
  /** Desktop menus also open tabs and splits. */
  desktop?: boolean;
}

/** The sessions grouped by state, most urgent first; the Ended group is collapsed. */
export function SessionList({
  data,
  followedId,
  renderedAt,
  sessionHref,
  onFollow,
  menuActions,
  desktop = true,
}: SessionListProps) {
  const t = useTranslations('workspace');
  const td = useTranslations('workspace.duration');
  const locale = useLocale();
  const now = useNow(renderedAt);
  const groups = groupIntoLanes(useGroupTransitions(data.sessions));
  // Right-click on a row opens its actions menu.
  const [menuSignal, setMenuSignal] = useState<{ id: string; n: number } | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const ended = group.status === 'ended';
        const count = ended ? data.endedTotal : group.sessions.length;
        return (
          <SessionGroup
            key={group.status}
            status={group.status}
            title={t(`lane.${group.status}`)}
            count={count}
            countLabel={t('lane.count', { count })}
            collapsible={ended}
            defaultOpen={ended && group.sessions.some((s) => s.id === followedId)}
            note={
              ended && data.endedTotal > group.sessions.length
                ? t('lane.endedShown', { shown: group.sessions.length, total: data.endedTotal })
                : undefined
            }
          >
            {group.sessions.map((session) => {
              const endedAt = session.endedAt ?? session.createdAt;
              const uptime = formatDuration(now - session.createdAt, td);
              return (
                <li key={session.id}>
                  <SessionRow
                    href={sessionHref(session.id)}
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
                    transitionName={`session-${session.id}`}
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
                        <SessionMenu
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
          </SessionGroup>
        );
      })}
    </div>
  );
}

/**
 * The rail: one compact tile per session, grouped in the same order with a hairline between
 * groups; ended sessions stay out of the rail (they are history, reached from the full list).
 */
export function SessionRail({
  data,
  followedId,
  sessionHref,
  onFollow,
}: Pick<SessionListProps, 'data' | 'followedId' | 'sessionHref' | 'onFollow'>) {
  const t = useTranslations('workspace');
  const groups = groupIntoLanes(data.sessions).filter((group) => group.status !== 'ended');
  return (
    <div className="flex flex-col items-center gap-2">
      {groups.map((group, index) => (
        <ul
          key={group.status}
          aria-label={t(`lane.${group.status}`)}
          className={
            index > 0
              ? 'flex flex-col items-center gap-1 border-line border-t pt-2'
              : 'flex flex-col items-center gap-1'
          }
        >
          {group.sessions.map((session) => (
            <li key={session.id}>
              <SessionTile
                href={sessionHref(session.id)}
                label={session.label}
                target={`${session.user}@${session.host}`}
                status={session.status}
                statusLabel={t(`status.${session.status}`)}
                followed={session.id === followedId}
                onClick={
                  onFollow
                    ? (event) => {
                        if (!isPlainClick(event)) return;
                        event.preventDefault();
                        onFollow(session.id);
                      }
                    : undefined
                }
              />
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
