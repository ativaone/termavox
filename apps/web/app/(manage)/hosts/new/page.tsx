import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AddServerForm } from '../../../../components/hosts/add-server-form.tsx';
import { ArrowLeftIcon, HostIcon } from '../../../../components/icons/index.tsx';
import { ButtonLink } from '../../../../components/ui/button.tsx';
import { PageHeader } from '../../../../components/ui/page-header.tsx';
import { Panel } from '../../../../components/ui/panel.tsx';
import { getAuthRuntime, requireSession } from '../../../../lib/auth/server.ts';
import { backLinkFrom } from '../../../../lib/manage/back-link.ts';
import { localKindAvailability } from '../../../../lib/manage/local-kind.ts';
import { listCredentials } from '../../../../lib/repo/credentials.ts';
import { listHosts } from '../../../../lib/repo/hosts.ts';
import { getInstanceSettings } from '../../../../lib/repo/instance-settings.ts';
import { ROUTES } from '../../../../lib/routes.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('hostNew') };
}

/**
 * "Add server" (plan D-27): server, sign-in and credential on one page, creating whatever is
 * missing at once. `?from=` (read only through safeReturnPath) is where Back and Cancel lead.
 */
export default async function AddServerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.addServer');
  const { db } = getAuthRuntime();
  const { from } = await searchParams;
  const back = (await backLinkFrom(from, user.id)) ?? (await backLinkFrom(ROUTES.hosts, user.id));
  if (!back) throw new Error('the hosts page must be a valid return path');
  const local = localKindAvailability(getInstanceSettings(db), user.role);
  const hosts = listHosts(db, user.id).map((host) => ({
    id: host.id,
    name: host.name,
    kind: host.kind,
    address: host.kind === 'ssh' ? `${host.hostname}:${host.port}` : null,
  }));
  const credentials = listCredentials(db, user.id).map((c) => ({ id: c.id, name: c.name }));

  return (
    <>
      <div className="-mb-3 -ms-3">
        <ButtonLink href={back.href} variant="quiet" size="sm" icon={<ArrowLeftIcon size={16} />}>
          {back.label}
        </ButtonLink>
      </div>
      <PageHeader title={t('title')} description={t('intro')} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,46rem)_minmax(0,19rem)]">
        <AddServerForm
          hosts={hosts}
          credentials={credentials}
          localAllowed={local.allowed}
          back={back}
        />
        <Panel aria-labelledby="add-server-docker" className="flex flex-col gap-3 p-5">
          <span className="inline-flex size-9 items-center justify-center rounded-control bg-surface-raised text-ink-muted">
            <HostIcon size={18} />
          </span>
          <h2 id="add-server-docker" className="font-semibold text-ink text-base">
            {t('docker.title')}
          </h2>
          <p className="text-pretty text-ink-muted text-sm">{t('docker.body')}</p>
          <div>
            <ButtonLink href="/hosts/docker" variant="secondary" size="sm">
              {t('docker.cta')}
            </ButtonLink>
          </div>
        </Panel>
      </div>
    </>
  );
}
