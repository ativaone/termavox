import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { useId } from 'react';
import { CopyIcon, PlusIcon, ServerIcon } from '../../../components/icons/index.tsx';
import { DoneNotice } from '../../../components/manage/done-notice.tsx';
import { ButtonLink } from '../../../components/ui/button.tsx';
import { DataTable, Td, Th, Tr } from '../../../components/ui/data-table.tsx';
import { EmptyState } from '../../../components/ui/empty-state.tsx';
import { PageHeader } from '../../../components/ui/page-header.tsx';
import { Panel } from '../../../components/ui/panel.tsx';
import { getAuthRuntime, requireSession } from '../../../lib/auth/server.ts';
import { withReturnPath } from '../../../lib/manage/return-to.ts';
import { listServers, type Server } from '../../../lib/repo/servers.ts';
import { duplicateServerPath, ROUTES, serverPath } from '../../../lib/routes.ts';
import { formatTarget } from '../../../lib/servers/target.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('servers') };
}

function NoServers({
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
      <EmptyState titleId={titleId} icon={<ServerIcon size={22} />} title={title} body={body}>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink
            href={withReturnPath(ROUTES.addServer, ROUTES.servers)}
            variant="primary"
            size="lg"
            icon={<PlusIcon size={18} />}
          >
            {add}
          </ButtonLink>
          <ButtonLink href={ROUTES.dockerServer} variant="secondary" size="lg">
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

/**
 * The servers list (plan D-29, §8.1 /servers): name, `user@address` (`:port` off 22), the
 * credential or "None", and edit / duplicate.
 */
export default async function ServersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const t = await getTranslations('servers');
  const servers = listServers(getAuthRuntime().db, user.id);
  const { done } = await searchParams;
  const target = (server: Server) =>
    server.kind === 'ssh' && server.hostname && server.port && server.username
      ? formatTarget(server.username, server.hostname, server.port)
      : t('list.local');

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('intro')}
        actions={
          servers.length > 0 ? (
            <>
              <ButtonLink href={ROUTES.dockerServer} variant="secondary">
                {t('docker.cta')}
              </ButtonLink>
              <ButtonLink
                href={withReturnPath(ROUTES.addServer, ROUTES.servers)}
                variant="primary"
                icon={<PlusIcon size={16} />}
              >
                {t('add')}
              </ButtonLink>
            </>
          ) : null
        }
      />
      <DoneNotice done={done} messages={{ serverDeleted: t('notice.serverDeleted') }} />
      {servers.length === 0 ? (
        <NoServers
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
                <Th>{t('list.target')}</Th>
                <Th>{t('list.credential')}</Th>
                <Th>
                  <span className="sr-only">{t('list.actions')}</span>
                </Th>
              </>
            }
          >
            {servers.map((server) => (
              <Tr key={server.id}>
                <Td primary>
                  <Link
                    href={serverPath(server.id)}
                    className="inline-flex items-center gap-2.5 font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
                  >
                    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm bg-surface-raised text-ink-muted">
                      <ServerIcon size={15} />
                    </span>
                    <span className="break-words">{server.name}</span>
                  </Link>
                </Td>
                <Td label={t('list.target')} className="break-all font-mono text-ink-muted text-sm">
                  {target(server)}
                </Td>
                <Td label={t('list.credential')} className="text-sm">
                  {server.kind === 'local' ? (
                    <span className="text-ink-muted">—</span>
                  ) : server.credentialName ? (
                    <span className="break-words text-ink">{server.credentialName}</span>
                  ) : (
                    <span className="text-ink-muted">{t('list.noCredential')}</span>
                  )}
                </Td>
                <Td className="max-md:pt-2">
                  <div className="flex flex-wrap items-center justify-end gap-2 max-md:justify-start">
                    <ButtonLink
                      href={serverPath(server.id)}
                      variant="secondary"
                      size="sm"
                      aria-label={t('list.editLabel', { name: server.name })}
                    >
                      {t('edit')}
                    </ButtonLink>
                    <ButtonLink
                      href={withReturnPath(duplicateServerPath(server.id), ROUTES.servers)}
                      variant="quiet"
                      size="sm"
                      icon={<CopyIcon size={15} />}
                      aria-label={t('list.duplicateLabel', { name: server.name })}
                    >
                      {t('duplicate')}
                    </ButtonLink>
                  </div>
                </Td>
              </Tr>
            ))}
          </DataTable>
        </Panel>
      )}
    </>
  );
}
