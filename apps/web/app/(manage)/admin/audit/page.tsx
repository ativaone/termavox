import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { param } from '../../../../components/manage/done-notice.tsx';
import { ButtonLink, buttonClasses } from '../../../../components/ui/button.tsx';
import { CONTROL_BASE, CONTROL_SIZE_COMPACT } from '../../../../components/ui/field.tsx';
import { LocalTime } from '../../../../components/ui/local-time.tsx';
import { Pagination, paginate } from '../../../../components/ui/pagination.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { NativeSelect } from '../../../../components/ui/select.tsx';
import { SheetTable, Td, Th, Tr } from '../../../../components/ui/sheet-table.tsx';
import { requireAdminPage } from '../../../../lib/admin/page-guard.ts';
import { getAuthRuntime } from '../../../../lib/auth/server.ts';
import { listUsersForAdmin } from '../../../../lib/repo/admin-users.ts';
import {
  type AuditFilter,
  type AuditRow,
  listAuditEvents,
  listAuditTypes,
} from '../../../../lib/repo/audit.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('adminAudit') };
}

const KNOWN_TYPES = new Set([
  'auth.login_success',
  'auth.login_failure',
  'auth.lockout',
  'auth.password_change',
  'auth.password_reset',
  'auth.totp_enable',
  'auth.totp_disable',
  'auth.totp_reset',
  'auth_session.revoke',
  'user.create',
  'user.ban',
  'user.unban',
  'user.role_change',
  'user.sessions_terminate',
  'admin_setting.change',
  'credential.create',
  'credential.rename',
  'credential.delete',
  'host_key.pending',
  'host_key.trust',
  'host_key.replace',
  'host_key.revoke',
  'host_key.mismatch',
]);

/** Message keys cannot contain dots (next-intl nesting), so `auth.lockout` reads `auth_lockout`. */
type AuditTypeKey =
  | 'auth_login_success'
  | 'auth_login_failure'
  | 'auth_lockout'
  | 'auth_password_change'
  | 'auth_password_reset'
  | 'auth_totp_enable'
  | 'auth_totp_disable'
  | 'auth_totp_reset'
  | 'auth_session_revoke'
  | 'user_create'
  | 'user_ban'
  | 'user_unban'
  | 'user_role_change'
  | 'user_sessions_terminate'
  | 'admin_setting_change'
  | 'credential_create'
  | 'credential_rename'
  | 'credential_delete'
  | 'host_key_pending'
  | 'host_key_trust'
  | 'host_key_replace'
  | 'host_key_revoke'
  | 'host_key_mismatch';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` (UTC) → epoch ms at the start of that day, or undefined. */
function dayStart(value: string | undefined): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

function detailSummary(detail: Record<string, unknown> | null): string {
  if (!detail) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || typeof value === 'object') continue;
    parts.push(`${key}: ${String(value).slice(0, 80)}`);
  }
  const text = parts.join(' · ');
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** A readable target: the user, host or credential name, a setting key, or a short id. */
function targetLabel(row: AuditRow): string {
  if (row.targetName) return row.targetName;
  if (row.targetType === 'setting' && row.targetId) return row.targetId;
  const name = row.detail?.name;
  if (typeof name === 'string') return name;
  if (!row.targetId) return '—';
  return row.targetId.length > 12 ? `${row.targetId.slice(0, 8)}…` : row.targetId;
}

/** Audit log viewer (plan §8.1 /admin/audit): filters by type, actor and date range. */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireAdminPage();
  const t = await getTranslations('admin.audit');
  const tp = await getTranslations('manage.pagination');
  const search = await searchParams;
  const { db } = getAuthRuntime();
  const types = listAuditTypes(db, user);
  const users = listUsersForAdmin(db, user);
  const type = param(search.type) ?? '';
  const actor = param(search.actor) ?? '';
  const from = param(search.from) ?? '';
  const to = param(search.to) ?? '';
  const toStart = dayStart(to);
  const filter: AuditFilter = {
    ...(type ? { type } : {}),
    ...(actor ? { actorId: actor } : {}),
    ...(dayStart(from) !== undefined ? { from: dayStart(from) } : {}),
    ...(toStart !== undefined ? { to: toStart + DAY_MS - 1 } : {}),
  };
  const data = paginate(search.page, (page) => listAuditEvents(db, user, filter, page));
  const label = (value: string) =>
    KNOWN_TYPES.has(value) ? t(`type.${value.replaceAll('.', '_') as AuditTypeKey}`) : value;
  const query = (page: number) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (actor) params.set('actor', actor);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    return qs ? `/admin/audit?${qs}` : '/admin/audit';
  };
  const filtered = Boolean(type || actor || from || to);
  const dateClass = `${CONTROL_BASE} ${CONTROL_SIZE_COMPACT} tabular-nums`;

  return (
    <Panel aria-label={t('title')}>
      <PanelSection>
        <form method="get" action="/admin/audit" className="flex flex-col gap-4">
          <h2 className="font-semibold text-ink text-md">{t('filters')}</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="audit-type" className="font-semibold text-ink text-sm">
                {t('filterType')}
              </label>
              <NativeSelect
                id="audit-type"
                name="type"
                compact
                defaultValue={type}
                options={[
                  { value: '', label: t('allTypes') },
                  ...types.map((value) => ({ value, label: label(value) })),
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="audit-actor" className="font-semibold text-ink text-sm">
                {t('filterActor')}
              </label>
              <NativeSelect
                id="audit-actor"
                name="actor"
                compact
                defaultValue={actor}
                options={[
                  { value: '', label: t('allActors') },
                  ...users.map((u) => ({ value: u.id, label: u.username })),
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="audit-from" className="font-semibold text-ink text-sm">
                {t('from')}
              </label>
              <input
                type="date"
                id="audit-from"
                name="from"
                defaultValue={from}
                className={dateClass}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="audit-to" className="font-semibold text-ink text-sm">
                {t('to')}
              </label>
              <input type="date" id="audit-to" name="to" defaultValue={to} className={dateClass} />
            </div>
            <div className="flex items-end gap-2">
              <button type="submit" className={buttonClasses({ variant: 'primary', size: 'sm' })}>
                {t('apply')}
              </button>
              {filtered ? (
                <ButtonLink href="/admin/audit" variant="quiet" size="sm">
                  {t('clear')}
                </ButtonLink>
              ) : null}
            </div>
          </div>
          <p className="text-ink-muted text-sm">{t('utc')}</p>
        </form>
      </PanelSection>
      {data.total === 0 ? (
        <PanelSection ruled>
          <p className="text-pretty text-base text-ink-muted">
            {filtered ? t('emptyFiltered') : t('empty')}
          </p>
        </PanelSection>
      ) : (
        <div className="border-rule border-t">
          <SheetTable
            caption={t('caption', { total: data.total })}
            head={
              <>
                <Th className="w-44">{t('time')}</Th>
                <Th>{t('event')}</Th>
                <Th>{t('actor')}</Th>
                <Th>{t('target')}</Th>
                <Th>{t('source')}</Th>
                <Th>{t('detail')}</Th>
              </>
            }
          >
            {data.rows.map((row) => (
              <Tr key={row.id}>
                <Td label={t('time')} className="whitespace-nowrap text-sm">
                  <LocalTime at={row.createdAt} withSeconds />
                </Td>
                <Td primary className="md:min-w-40">
                  <span className="font-semibold">{label(row.type)}</span>
                </Td>
                <Td label={t('actor')} className="text-sm">
                  {row.actorName ?? (row.actorId ? row.actorId.slice(0, 8) : t('system'))}
                </Td>
                <Td label={t('target')} className="text-sm [overflow-wrap:anywhere]">
                  {targetLabel(row)}
                </Td>
                <Td label={t('source')} className="text-ink-muted text-sm">
                  <span className="flex min-w-0 flex-col">
                    <span className="whitespace-nowrap">{row.ip ?? '—'}</span>
                    {row.userAgent ? (
                      <span className="block max-w-[12rem] truncate text-xs" title={row.userAgent}>
                        {row.userAgent}
                      </span>
                    ) : null}
                  </span>
                </Td>
                <Td label={t('detail')} className="text-ink-muted text-sm [overflow-wrap:anywhere]">
                  {detailSummary(row.detail) || '—'}
                </Td>
              </Tr>
            ))}
          </SheetTable>
        </div>
      )}
      {data.pageCount > 1 ? (
        <PanelSection ruled className="py-3 sm:py-3">
          <Pagination
            page={data.page}
            pageCount={data.pageCount}
            hrefFor={query}
            labels={{
              nav: tp('nav'),
              previous: tp('previous'),
              next: tp('next'),
              status: tp('status', { page: data.page, pageCount: data.pageCount }),
            }}
          />
        </PanelSection>
      ) : null}
    </Panel>
  );
}
