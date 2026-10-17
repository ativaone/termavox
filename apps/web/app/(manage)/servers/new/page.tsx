import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon, ServerIcon } from '../../../../components/icons/index.tsx';
import { param } from '../../../../components/manage/done-notice.tsx';
import { AddServerForm } from '../../../../components/servers/add-server-form.tsx';
import { ButtonLink } from '../../../../components/ui/button.tsx';
import { Notice } from '../../../../components/ui/notice.tsx';
import { PageHeader } from '../../../../components/ui/page-header.tsx';
import { Panel } from '../../../../components/ui/panel.tsx';
import { prefillFrom } from '../../../../lib/actions/add-server-core.ts';
import { getAuthRuntime, requireSession } from '../../../../lib/auth/server.ts';
import { backLinkFrom } from '../../../../lib/manage/back-link.ts';
import { localKindAvailability } from '../../../../lib/manage/local-kind.ts';
import { listCredentials } from '../../../../lib/repo/credentials.ts';
import { getInstanceSettings } from '../../../../lib/repo/instance-settings.ts';
import { getServer } from '../../../../lib/repo/servers.ts';
import { ROUTES } from '../../../../lib/routes.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('addServer') };
}

/**
 * "Add server" (plan D-29): the server and its credential on one page. `?duplicate=<id>` starts
 * from a copy of one of the user's servers (ownership checked by the user-scoped read; another
 * user's or a missing id gives an empty form with a note). `?from=` (read only through
 * safeReturnPath) is where Back and Cancel lead.
 */
export default async function AddServerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const t = await getTranslations('servers.addServer');
  const ts = await getTranslations('servers');
  const { db } = getAuthRuntime();
  const search = await searchParams;
  const back =
    (await backLinkFrom(search.from, user.id)) ?? (await backLinkFrom(ROUTES.servers, user.id));
  if (!back) throw new Error('the servers page must be a valid return path');
  const local = localKindAvailability(getInstanceSettings(db), user.role);
  const credentials = listCredentials(db, user.id).map((c) => ({ id: c.id, name: c.name }));
  const duplicateId = param(search.duplicate);
  const source = duplicateId ? getServer(db, user.id, duplicateId) : null;
  const initialValues = source
    ? prefillFrom(source, (name) => ts('copyName', { name }))
    : undefined;

  return (
    <>
      <div className="-mb-3 -ms-3">
        <ButtonLink href={back.href} variant="quiet" size="sm" icon={<ArrowLeftIcon size={16} />}>
          {back.label}
        </ButtonLink>
      </div>
      <PageHeader
        title={t('title')}
        description={source ? t('duplicateIntro', { name: source.name }) : t('intro')}
      />
      {duplicateId && !source ? <Notice tone="info">{t('duplicateMissing')}</Notice> : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,46rem)_minmax(0,19rem)]">
        <AddServerForm
          key={source?.id ?? 'new'}
          credentials={credentials}
          localAllowed={local.allowed}
          back={back}
          {...(initialValues ? { initialValues } : {})}
        />
        <Panel aria-labelledby="add-server-docker" className="flex flex-col gap-3 p-5">
          <span className="inline-flex size-9 items-center justify-center rounded-control bg-surface-raised text-ink-muted">
            <ServerIcon size={18} />
          </span>
          <h2 id="add-server-docker" className="font-semibold text-ink text-base">
            {t('docker.title')}
          </h2>
          <p className="text-pretty text-ink-muted text-sm">{t('docker.body')}</p>
          <div>
            <ButtonLink href={ROUTES.dockerServer} variant="secondary" size="sm">
              {t('docker.cta')}
            </ButtonLink>
          </div>
        </Panel>
      </div>
    </>
  );
}
