import { ProtectionNotice } from '@termavox/protocol/client';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { param } from '../../../components/manage/done-notice.tsx';
import { cx } from '../../../components/ui/cx.ts';
import { DataTable, Td, Th, Tr } from '../../../components/ui/data-table.tsx';
import { LocalTime } from '../../../components/ui/local-time.tsx';
import { PageHeader } from '../../../components/ui/page-header.tsx';
import { Pagination, paginate } from '../../../components/ui/pagination.tsx';
import { Panel, PanelSection } from '../../../components/ui/panel.tsx';
import { StatusChip } from '../../../components/ui/status-chip.tsx';
import { getAuthRuntime, requireSession } from '../../../lib/auth/server.ts';
import { listSessionEvents, listSessionHistory } from '../../../lib/repo/activity.ts';
import { collapseRuns, describeStateChange, statusOf } from '../../../lib/sessions/activity.ts';
import { END_KEYS, FAILURE_KEYS, pick } from '../../../lib/sessions/reasons.ts';
import { sessionTarget } from '../../../lib/sessions/target.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('activity') };
}

const KNOWN_EVENTS = [
  'created',
  'state_changed',
  'reopened',
  'restore_started',
  'restored',
  'restore_failed',
  'connection_lost',
  'host_key_unknown',
  'host_key_rejected',
  'host_key_mismatch',
  'host_key_revoked_presented',
  'auth_prompt',
  'auth_prompt_expired',
  'protection_selected',
  'protection_degraded',
  'remote_rebooted',
  'desync',
  'attached',
  'detached',
  'host_key_trusted',
  'host_key_expired',
  'server_deleted',
] as const;
type KnownEvent = (typeof KNOWN_EVENTS)[number];
const isKnownEvent = (type: string): type is KnownEvent =>
  (KNOWN_EVENTS as readonly string[]).includes(type);

/** Daemon protection notices by `noticeCode`, mapped to their message key. */
const NOTICE_CODE_KEYS = {
  tmux_missing: 'tmuxMissing',
  tmux_too_old: 'tmuxTooOld',
  no_utf8: 'noUtf8',
  control_unavailable: 'controlUnavailable',
} as const satisfies Record<ProtectionNotice, string>;

/** Rows written before `noticeCode` existed carry only the English sentence. */
const NOTICE_KEYS = {
  'tmux not found on the host: session not protected': 'tmuxMissing',
  'no UTF-8 locale on the host: session not protected': 'noUtf8',
  'tmux control mode is not available: session not protected': 'controlUnavailable',
} as const;

function noticeKey(code: unknown, notice: unknown) {
  const parsed = ProtectionNotice.safeParse(code);
  if (parsed.success) return NOTICE_CODE_KEYS[parsed.data];
  if (typeof notice !== 'string') return null;
  // "tmux too old (tmux 3.0a): session not protected" names the version it found.
  if (notice.startsWith('tmux too old (')) return 'tmuxTooOld';
  return pick(NOTICE_KEYS, notice);
}

const PROTECTIONS = ['tmux-control', 'tmux-normal', 'none'] as const;
const isProtection = (value: unknown): value is (typeof PROTECTIONS)[number] =>
  (PROTECTIONS as readonly unknown[]).includes(value);

/** Public detail fields of an event type nobody mapped yet; ids and anything long are left out. */
function rawSummary(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (key.endsWith('Id') || key === 'id') continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    parts.push(`${key}: ${String(value).slice(0, 80)}`);
  }
  const text = parts.join(' · ');
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** The user's own session history and session events (plan §8.1 /activity), newest first. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const t = await getTranslations('activity');
  const tw = await getTranslations('workspace');
  const tc = await getTranslations('manage.pagination');
  const search = await searchParams;
  const view = param(search.view) === 'sessions' ? 'sessions' : 'events';

  const statusWord = (state: unknown) => {
    const status = statusOf(state);
    return status ? tw(`status.${status}`) : null;
  };
  const reasonText = (code: unknown) => {
    const failure = pick(FAILURE_KEYS, typeof code === 'string' ? code : null);
    if (failure) return tw(`failure.${failure}`);
    const end = pick(END_KEYS, typeof code === 'string' ? code : null);
    return end ? tw(`endReason.${end}`) : null;
  };
  const noticeText = (detail: Record<string, unknown>) => {
    const key = noticeKey(detail.noticeCode, detail.notice);
    return key ? t(`detail.notice.${key}`) : null;
  };
  /** The event's details in the user's words: status words, reasons, counts; never raw codes. */
  const detailSummary = (type: string, detail: Record<string, unknown> | null): string => {
    if (!detail) return '';
    const join = (...parts: Array<string | null>) => parts.filter(Boolean).join(' · ');
    switch (type) {
      case 'state_changed':
        return describeStateChange(detail, {
          status: (status) => tw(`status.${status}`),
          phase: (phase) => t(`detail.phase.${phase}`),
          transition: (from, to) => t('detail.transition', { from, to }),
          reason: reasonText,
        });
      case 'restore_failed': {
        const status = statusWord(detail.state);
        return status ? t('detail.state', { status }) : '';
      }
      case 'host_key_unknown':
      case 'host_key_rejected':
      case 'host_key_trusted':
      case 'host_key_expired':
      case 'host_key_mismatch':
      case 'host_key_revoked_presented': {
        const keyType = detail.keyType ?? detail.type;
        return join(
          typeof keyType === 'string' ? keyType : null,
          typeof detail.fingerprint === 'string' ? detail.fingerprint : null,
        );
      }
      case 'auth_prompt':
        return typeof detail.prompts === 'number'
          ? t('detail.prompts', { count: detail.prompts })
          : '';
      case 'protection_selected':
        return join(
          isProtection(detail.protection) ? t(`protection.${detail.protection}`) : null,
          noticeText(detail),
        );
      case 'protection_degraded':
        return join(
          isProtection(detail.from)
            ? t('detail.protectionWas', { protection: t(`protection.${detail.from}`) })
            : null,
          noticeText(detail),
        );
      // Ids only (created) or diagnostics for the operator log (desync): nothing to show.
      case 'created':
      case 'desync':
        return '';
      default:
        return isKnownEvent(type) ? '' : rawSummary(detail);
    }
  };
  const { db } = getAuthRuntime();
  const href = (v: string, page = 1) =>
    `/activity?${new URLSearchParams({ ...(v === 'sessions' ? { view: v } : {}), ...(page > 1 ? { page: String(page) } : {}) })}`;

  const tabs = (
    <nav aria-label={t('views')} className="border-line border-b">
      <ul className="-mb-px flex gap-1">
        {(['events', 'sessions'] as const).map((v) => (
          <li key={v} className="flex">
            <Link
              href={href(v)}
              aria-current={view === v ? 'page' : undefined}
              className={cx(
                'flex h-10 items-center border-transparent border-b-2 px-3 font-medium text-base',
                'text-ink-muted transition-colors duration-(--duration-step) ease-(--ease-out) hover:text-ink',
                view === v && 'border-b-accent text-ink',
              )}
            >
              {t(`view.${v}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );

  const pageLabels = (page: number, pageCount: number) => ({
    nav: tc('nav'),
    previous: tc('previous'),
    next: tc('next'),
    status: tc('status', { page, pageCount }),
  });

  if (view === 'sessions') {
    const data = paginate(search.page, (page) => listSessionHistory(db, user.id, page));
    return (
      <>
        <PageHeader title={t('title')} description={t('intro')} />
        {tabs}
        <Panel aria-label={t('sessions.caption')}>
          {data.total === 0 ? (
            <PanelSection>
              <p className="text-pretty text-base text-ink-muted">{t('sessions.empty')}</p>
            </PanelSection>
          ) : (
            <DataTable
              caption={t('sessions.caption')}
              head={
                <>
                  <Th>{t('sessions.session')}</Th>
                  <Th>{t('sessions.status')}</Th>
                  <Th>{t('sessions.protection')}</Th>
                  <Th>{t('sessions.started')}</Th>
                  <Th>{t('sessions.ended')}</Th>
                </>
              }
            >
              {data.rows.map((row) => (
                <Tr key={row.id}>
                  <Td primary>
                    <span className="flex min-w-0 flex-col">
                      <span className="break-words font-semibold">{row.label}</span>
                      <span className="break-all text-ink-muted text-sm">
                        {sessionTarget(row, tw('localTarget'))}
                      </span>
                    </span>
                  </Td>
                  <Td label={t('sessions.status')}>
                    <StatusChip status={row.status} label={tw(`status.${row.status}`)} />
                  </Td>
                  <Td label={t('sessions.protection')} className="text-sm">
                    {t(`protection.${row.protection ?? 'pending'}`)}
                  </Td>
                  <Td label={t('sessions.started')} className="text-sm">
                    <LocalTime at={row.createdAt} />
                  </Td>
                  <Td label={t('sessions.ended')} className="text-sm">
                    {row.endedAt ? (
                      <span className="flex flex-col">
                        <LocalTime at={row.endedAt} />
                        {row.endReason ? (
                          <span className="text-ink-muted">
                            {reasonText(row.endReason) ?? tw('endReason.unknown')}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-ink-muted">{t('sessions.running')}</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </DataTable>
          )}
          {data.pageCount > 1 ? (
            <PanelSection ruled className="py-3 sm:py-3">
              <Pagination
                page={data.page}
                pageCount={data.pageCount}
                hrefFor={(p) => href('sessions', p)}
                labels={pageLabels(data.page, data.pageCount)}
              />
            </PanelSection>
          ) : null}
        </Panel>
      </>
    );
  }

  const data = paginate(search.page, (page) => listSessionEvents(db, user.id, page));
  // Repeats in a row (same session, event and words) read as one row with a count.
  const runs = collapseRuns(
    data.rows.map((row) => ({ ...row, summary: detailSummary(row.type, row.detail) })),
    (row) => JSON.stringify([row.sessionId, row.type, row.summary]),
  );
  return (
    <>
      <PageHeader title={t('title')} description={t('intro')} />
      {tabs}
      <Panel aria-label={t('events.caption')}>
        {data.total === 0 ? (
          <PanelSection>
            <p className="text-pretty text-base text-ink-muted">{t('events.empty')}</p>
          </PanelSection>
        ) : (
          <DataTable
            caption={t('events.caption')}
            head={
              <>
                <Th className="w-48">{t('events.time')}</Th>
                <Th>{t('events.event')}</Th>
                <Th>{t('events.session')}</Th>
                <Th>{t('events.detail')}</Th>
              </>
            }
          >
            {runs.map(({ row, count }) => (
              <Tr key={row.id}>
                <Td label={t('events.time')} className="text-sm">
                  <LocalTime at={row.createdAt} withSeconds />
                </Td>
                <Td primary>
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold">
                      {isKnownEvent(row.type) ? t(`type.${row.type}`) : row.type}
                    </span>
                    {count > 1 ? (
                      <span className="rounded-pill bg-surface-raised px-1.5 font-data font-semibold text-2xs text-ink-muted">
                        <span aria-hidden="true">×{count}</span>
                        <span className="sr-only">{t('events.repeated', { count })}</span>
                      </span>
                    ) : null}
                  </span>
                </Td>
                <Td label={t('events.session')}>
                  <span className="flex min-w-0 flex-col">
                    <span className="break-words">{row.sessionLabel}</span>
                    <span className="break-all text-ink-muted text-sm">{row.server}</span>
                  </span>
                </Td>
                <Td
                  label={t('events.detail')}
                  className="text-ink-muted text-sm [overflow-wrap:anywhere]"
                >
                  {row.summary || '—'}
                </Td>
              </Tr>
            ))}
          </DataTable>
        )}
        {data.pageCount > 1 ? (
          <PanelSection ruled className="py-3 sm:py-3">
            <Pagination
              page={data.page}
              pageCount={data.pageCount}
              hrefFor={(p) => href('events', p)}
              labels={pageLabels(data.page, data.pageCount)}
            />
          </PanelSection>
        ) : null}
      </Panel>
    </>
  );
}
