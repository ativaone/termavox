import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CreateUserForm } from '../../../../components/admin/user-forms.tsx';
import { LocalTime } from '../../../../components/ui/local-time.tsx';
import { SheetHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { SheetTable, Td, Th, Tr } from '../../../../components/ui/sheet-table.tsx';
import { Tag } from '../../../../components/ui/tag.tsx';
import { isAdminRole } from '../../../../lib/admin/core.ts';
import { requireAdminPage } from '../../../../lib/admin/page-guard.ts';
import { isTotpRequiredInstanceWide } from '../../../../lib/auth/queries.ts';
import { getAuthRuntime } from '../../../../lib/auth/server.ts';
import { listUsersForAdmin } from '../../../../lib/repo/admin-users.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('adminUsers') };
}

/** Users (plan §8.1 /admin/users): directory with role, status, 2FA, last sign-in; create. */
export default async function AdminUsersPage() {
  const { user } = await requireAdminPage();
  const t = await getTranslations('admin.users');
  const { db } = getAuthRuntime();
  const users = listUsersForAdmin(db, user);
  const instanceTotp = isTotpRequiredInstanceWide(db);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
      <Panel aria-labelledby="users-title">
        <PanelSection>
          <SheetHeading id="users-title" title={t('list.title')} description={t('list.intro')} />
        </PanelSection>
        <div className="border-rule border-t">
          <SheetTable
            caption={t('list.title')}
            head={
              <>
                <Th>{t('list.user')}</Th>
                <Th>{t('list.role')}</Th>
                <Th>{t('list.status')}</Th>
                <Th>{t('list.totp')}</Th>
                <Th>{t('list.lastSignIn')}</Th>
              </>
            }
          >
            {users.map((row) => {
              const required = row.totpRequired || instanceTotp;
              return (
                <Tr key={row.id}>
                  <Td primary>
                    <span className="flex min-w-0 flex-col">
                      <Link
                        href={`/admin/users/${encodeURIComponent(row.id)}`}
                        className="break-all font-semibold text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
                      >
                        {row.username}
                      </Link>
                      <span className="break-words text-ink-muted text-sm">{row.email}</span>
                    </span>
                  </Td>
                  <Td label={t('list.role')}>
                    <Tag tone={isAdminRole(row.role) ? 'info' : 'neutral'}>
                      {isAdminRole(row.role) ? t('role.admin') : t('role.user')}
                    </Tag>
                  </Td>
                  <Td label={t('list.status')}>
                    <span className="flex flex-wrap gap-1.5">
                      <Tag tone={row.banned ? 'danger' : 'success'}>
                        {row.banned ? t('status.disabled') : t('status.active')}
                      </Tag>
                      {row.mustChangePassword ? (
                        <Tag tone="warning">{t('status.mustChange')}</Tag>
                      ) : null}
                    </span>
                  </Td>
                  <Td label={t('list.totp')} className="text-sm">
                    {row.twoFactorEnabled
                      ? t('totp.on')
                      : required
                        ? t('totp.pending')
                        : t('totp.off')}
                  </Td>
                  <Td label={t('list.lastSignIn')} className="text-ink-muted text-sm">
                    {row.lastSignInAt ? <LocalTime at={row.lastSignInAt} /> : t('list.never')}
                  </Td>
                </Tr>
              );
            })}
          </SheetTable>
        </div>
      </Panel>
      <Panel aria-labelledby="create-user-title">
        <PanelSection>
          <SheetHeading
            id="create-user-title"
            title={t('create.title')}
            description={t('create.intro')}
          />
        </PanelSection>
        <PanelSection ruled>
          <CreateUserForm />
        </PanelSection>
      </Panel>
    </div>
  );
}
