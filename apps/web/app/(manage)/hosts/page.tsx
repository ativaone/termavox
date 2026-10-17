import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { useId } from 'react';
import { HostIcon, PlusIcon } from '../../../components/icons/index.tsx';
import { DoneNotice } from '../../../components/manage/done-notice.tsx';
import { ButtonLink } from '../../../components/ui/button.tsx';
import { DataTable, Td, Th, Tr } from '../../../components/ui/data-table.tsx';
import { EmptyState } from '../../../components/ui/empty-state.tsx';
import { PageHeader } from '../../../components/ui/page-header.tsx';
import { Panel } from '../../../components/ui/panel.tsx';
import { Tag } from '../../../components/ui/tag.tsx';
import { getAuthRuntime, requireSession } from '../../../lib/auth/server.ts';
import { type HostSummary, listHosts } from '../../../lib/repo/hosts.ts';
import { ROUTES } from '../../../lib/routes.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('hosts') };
}

function NoHosts({
  title,
  body,
  add,
  docker,
  dockerHelp,
}: {
  title: string;
  body: string;
  add: string;
  docker: string;
  dockerHelp: string;
}) {
  const titleId = useId();
  return (
    <Panel aria-labelledby={titleId} className="max-w-[36rem] p-6 sm:p-7">
      <EmptyState titleId={titleId} icon={<HostIcon size={22} />} title={title} body={body}>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink
            href={ROUTES.addServer}
            variant="primary"
            size="lg"
            icon={<PlusIcon size={18} />}
          >
            {add}
          </ButtonLink>
          <ButtonLink href="/hosts/docker" variant="secondary" size="lg">
            {docker}
          </ButtonLink>
        </div>
        <p className="max-w-[52ch] text-pretty border-line border-t pt-4 text-ink-muted text-sm">
          {dockerHelp}
        </p>
      </EmptyState>
    </Panel>
  );
}

/** Hosts list (plan §8.1 /hosts): name, address, kind, profiles and running sessions. */
export default async function HostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const t = await getTranslations('hosts');
  const hosts = listHosts(getAuthRuntime().db, user.id);
  const { done } = await searchParams;
  const address = (host: HostSummary) =>
    host.kind === 'local' ? t('list.localAddress') : `${host.hostname}:${host.port}`;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('intro')}
        actions={
          hosts.length > 0 ? (
            <>
              <ButtonLink href="/hosts/docker" variant="secondary">
                {t('docker.cta')}
              </ButtonLink>
              <ButtonLink href={ROUTES.addServer} variant="primary" icon={<PlusIcon size={16} />}>
                {t('add')}
              </ButtonLink>
            </>
          ) : null
        }
      />
      <DoneNotice done={done} messages={{ hostDeleted: t('notice.hostDeleted') }} />
      {hosts.length === 0 ? (
        <NoHosts
          title={t('empty.title')}
          body={t('empty.body')}
          add={t('add')}
          docker={t('docker.cta')}
          dockerHelp={t('empty.dockerHelp')}
        />
      ) : (
        <Panel aria-label={t('list.caption')} className="overflow-hidden">
          <DataTable
            caption={t('list.caption')}
            head={
              <>
                <Th>{t('list.name')}</Th>
                <Th>{t('list.address')}</Th>
                <Th>{t('list.kind')}</Th>
                <Th numeric>{t('list.profiles')}</Th>
                <Th numeric>{t('list.sessions')}</Th>
              </>
            }
          >
            {hosts.map((host) => (
              <Tr key={host.id}>
                <Td primary>
                  <Link
                    href={`/hosts/${encodeURIComponent(host.id)}`}
                    className="inline-flex items-center gap-2.5 font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
                  >
                    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm bg-surface-raised text-ink-muted">
                      <HostIcon size={15} />
                    </span>
                    {host.name}
                  </Link>
                </Td>
                <Td
                  label={t('list.address')}
                  className="break-all font-mono text-ink-muted text-sm"
                >
                  {address(host)}
                </Td>
                <Td label={t('list.kind')}>
                  <Tag>{t(`kind.${host.kind}`)}</Tag>
                </Td>
                <Td label={t('list.profiles')} numeric>
                  {host.profileCount}
                </Td>
                <Td label={t('list.sessions')} numeric>
                  <span
                    className={
                      host.liveSessionCount > 0 ? 'font-semibold text-ink' : 'text-ink-muted'
                    }
                  >
                    {host.liveSessionCount}
                  </span>
                </Td>
              </Tr>
            ))}
          </DataTable>
        </Panel>
      )}
    </>
  );
}
