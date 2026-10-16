import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import {
  BanControl,
  ResetPasswordForm,
  RoleForm,
} from '../../../../../components/admin/user-forms.tsx';
import { ChevronLeftIcon } from '../../../../../components/icons/index.tsx';
import { DoneNotice } from '../../../../../components/manage/done-notice.tsx';
import { ButtonLink } from '../../../../../components/ui/button.tsx';
import { ConfirmAction } from '../../../../../components/ui/confirm-action.tsx';
import { LocalTime } from '../../../../../components/ui/local-time.tsx';
import { SheetHeading } from '../../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../../components/ui/panel.tsx';
import { Tag } from '../../../../../components/ui/tag.tsx';
import { resetUserTotp } from '../../../../../lib/actions/admin.ts';
import { isAdminRole } from '../../../../../lib/admin/core.ts';
import { requireAdminPage } from '../../../../../lib/admin/page-guard.ts';
import { isTotpRequiredInstanceWide } from '../../../../../lib/auth/queries.ts';
import { getAuthRuntime } from '../../../../../lib/auth/server.ts';
import { countLiveSessionsForAdmin, getUserForAdmin } from '../../../../../lib/repo/admin-users.ts';

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('adminUser') };
}

/** One account: status, two-step verification, password and role (admins only). */
export default async function AdminUserPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user: admin } = await requireAdminPage();
  const { id } = await params;
  const { db } = getAuthRuntime();
  const target = getUserForAdmin(db, admin, id);
  if (!target) notFound();
  const t = await getTranslations('admin.users');
  const self = target.id === admin.id;
  const live = countLiveSessionsForAdmin(db, admin, target.id);
  const required = target.totpRequired || isTotpRequiredInstanceWide(db);
  const { done } = await searchParams;
  const facts: Array<[string, ReactNode]> = [
    [t('detail.email'), target.email],
    [t('detail.name'), target.name],
    [t('detail.created'), <LocalTime key="c" at={target.createdAt} />],
    [
      t('detail.lastSignIn'),
      target.lastSignInAt ? <LocalTime key="l" at={target.lastSignInAt} /> : t('list.never'),
    ],
    [t('detail.sessions'), t('detail.sessionsCount', { count: live })],
  ];

  return (
    <>
      <div className="flex flex-col items-start gap-3">
        <ButtonLink
          href="/admin/users"
          variant="quiet"
          size="sm"
          icon={<ChevronLeftIcon size={16} />}
        >
          {t('detail.back')}
        </ButtonLink>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="break-all font-semibold text-board-ink text-xl">{target.username}</h2>
          <Tag tone={target.banned ? 'danger' : 'success'}>
            {target.banned ? t('status.disabled') : t('status.active')}
          </Tag>
          <Tag tone={isAdminRole(target.role) ? 'info' : 'neutral'}>
            {isAdminRole(target.role) ? t('role.admin') : t('role.user')}
          </Tag>
        </div>
      </div>
      <DoneNotice
        done={done}
        messages={{ created: t('notice.created'), totpReset: t('notice.totpReset') }}
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Panel aria-labelledby="account-title">
            <PanelSection>
              <SheetHeading id="account-title" title={t('detail.title')} />
            </PanelSection>
            <PanelSection ruled>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 text-base">
                {facts.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="border-rule border-t py-2 text-ink-muted text-sm first:border-t-0">
                      {label}
                    </dt>
                    <dd className="break-words border-rule border-t py-2 text-ink tabular-nums">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </PanelSection>
          </Panel>
          <Panel aria-labelledby="ban-title">
            <PanelSection>
              <SheetHeading id="ban-title" title={t('ban.title')} />
            </PanelSection>
            <PanelSection ruled>
              {self ? (
                <p className="text-pretty text-base text-ink-muted">{t('ban.self')}</p>
              ) : (
                <BanControl
                  userId={target.id}
                  username={target.username}
                  banned={target.banned}
                  liveSessions={live}
                />
              )}
            </PanelSection>
          </Panel>
        </div>
        <div className="flex flex-col gap-6">
          <Panel aria-labelledby="totp-title">
            <PanelSection>
              <SheetHeading
                id="totp-title"
                title={t('totpReset.title')}
                action={
                  <Tag tone={target.twoFactorEnabled ? 'success' : 'neutral'}>
                    {target.twoFactorEnabled
                      ? t('totp.on')
                      : required
                        ? t('totp.pending')
                        : t('totp.off')}
                  </Tag>
                }
              />
            </PanelSection>
            <PanelSection ruled className="flex flex-col gap-3">
              <p className="max-w-[60ch] text-pretty text-base text-ink-muted">
                {target.twoFactorEnabled ? t('totpReset.intro') : t('totpReset.notEnrolled')}
              </p>
              {target.twoFactorEnabled ? (
                <ConfirmAction
                  label={t('totpReset.label')}
                  question={t('totpReset.question', { username: target.username })}
                  confirmLabel={t('totpReset.confirm')}
                  action={resetUserTotp}
                  hidden={{ userId: target.id }}
                  isolated={false}
                />
              ) : null}
            </PanelSection>
          </Panel>
          <Panel aria-labelledby="password-title">
            <PanelSection>
              <SheetHeading
                id="password-title"
                title={t('password.title')}
                description={t('password.intro')}
              />
            </PanelSection>
            <PanelSection ruled>
              <ResetPasswordForm userId={target.id} />
            </PanelSection>
          </Panel>
          <Panel aria-labelledby="role-title">
            <PanelSection>
              <SheetHeading id="role-title" title={t('role.title')} />
            </PanelSection>
            <PanelSection ruled>
              <RoleForm
                userId={target.id}
                role={isAdminRole(target.role) ? 'admin' : 'user'}
                disabled={self}
              />
            </PanelSection>
          </Panel>
        </div>
      </div>
    </>
  );
}
