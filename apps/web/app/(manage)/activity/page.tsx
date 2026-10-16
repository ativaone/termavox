import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { param } from '../../../components/manage/done-notice.tsx';
import { cx } from '../../../components/ui/cx.ts';
import { LocalTime } from '../../../components/ui/local-time.tsx';
import { PageHeader } from '../../../components/ui/page-header.tsx';
import { Pagination, paginate } from '../../../components/ui/pagination.tsx';
import { Panel, PanelSection } from '../../../components/ui/panel.tsx';
import { SheetTable, Td, Th, Tr } from '../../../components/ui/sheet-table.tsx';
import { StatusChip } from '../../../components/ui/status-chip.tsx';
import { getAuthRuntime, requireSession } from '../../../lib/auth/server.ts';
import { listSessionEvents, listSessionHistory } from '../../../lib/repo/activity.ts';

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
  'auth_prompt',
  'auth_prompt_expired',
  'protection_selected',
  'protection_degraded',
  'remote_rebooted',
  'desync',
] as const;
type KnownEvent = (typeof KNOWN_EVENTS)[number];
const isKnownEvent = (type: string): type is KnownEvent =>
  (KNOWN_EVENTS as readonly string[]).includes(type);

/** Public detail fields worth a glance; ids and anything long are left out. */
function detailSummary(type: string, detail: Record<string, unknown> | null): string {
  if (!detail) return '';
  if (
    type === 'state_changed' &&
    typeof detail.from === 'string' &&
    typeof detail.to === 'string'
  ) {
    const code = typeof detail.detail === 'string' ? ` (${detail.detail})` : '';
    return `${detail.from} → ${detail.to}${code}`;
  }
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
  const { db } = getAuthRuntime();
  const href = (v: string, page = 1) =>
    `/activity?${new URLSearchParams({ ...(v === 'sessions' ? { view: v } : {}), ...(page > 1 ? { page: String(page) } : {}) })}`;

  const tabs = (
    <nav aria-label={t('views')} className="border-board-rule border-b">
      <ul className="-mb-px flex gap-1">
        {(['events', 'sessions'] as const).map((v) => (
          <li key={v} className="flex">
            <Link
              href={href(v)}
              aria-current={view === v ? 'page' : undefined}
              className={cx(
                'flex h-10 items-center border-transparent border-b-2 px-3 font-medium text-base',
                'text-board-ink-muted transition-colors duration-(--duration-step) ease-linear hover:text-board-ink',
                view === v && 'border-b-stock text-board-ink',
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
            <SheetTable
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
                        {row.user}@{row.host}
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
                          <span className="text-ink-muted">{row.endReason}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-ink-muted">{t('sessions.running')}</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </SheetTable>
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
          <SheetTable
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
            {data.rows.map((row) => (
              <Tr key={row.id}>
                <Td label={t('events.time')} className="text-sm">
                  <LocalTime at={row.createdAt} withSeconds />
                </Td>
                <Td primary>
                  <span className="font-semibold">
                    {isKnownEvent(row.type) ? t(`type.${row.type}`) : row.type}
                  </span>
                </Td>
                <Td label={t('events.session')}>
                  <span className="flex min-w-0 flex-col">
                    <span className="break-words">{row.sessionLabel}</span>
                    <span className="break-all text-ink-muted text-sm">{row.host}</span>
                  </span>
                </Td>
                <Td
                  label={t('events.detail')}
                  className="text-ink-muted text-sm [overflow-wrap:anywhere]"
                >
                  {detailSummary(row.type, row.detail) || '—'}
                </Td>
              </Tr>
            ))}
          </SheetTable>
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
