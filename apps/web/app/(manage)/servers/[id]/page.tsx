import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LearnMore } from '../../../../components/help-links.tsx';
import { ArrowLeftIcon, CopyIcon } from '../../../../components/icons/index.tsx';
import { DoneNotice } from '../../../../components/manage/done-notice.tsx';
import {
  FingerprintText,
  PretrustForm,
  ReplaceKeyForm,
  TestConnection,
  TrustKeyButton,
} from '../../../../components/servers/diagnostics.tsx';
import { RemoteSessions } from '../../../../components/servers/remote-sessions.tsx';
import { ServerForm } from '../../../../components/servers/server-form.tsx';
import { ButtonLink } from '../../../../components/ui/button.tsx';
import { ConfirmAction } from '../../../../components/ui/confirm-action.tsx';
import { DisclosureSummary } from '../../../../components/ui/disclosure-summary.tsx';
import { LocalTime } from '../../../../components/ui/local-time.tsx';
import { Notice } from '../../../../components/ui/notice.tsx';
import { PageHeader, SectionHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { Tag } from '../../../../components/ui/tag.tsx';
import { deleteServer, revokeHostKey } from '../../../../lib/actions/servers.ts';
import { getAuthRuntime, requireSession } from '../../../../lib/auth/server.ts';
import { backLinkFrom } from '../../../../lib/manage/back-link.ts';
import { localKindAvailability } from '../../../../lib/manage/local-kind.ts';
import { withReturnPath } from '../../../../lib/manage/return-to.ts';
import { listCredentials } from '../../../../lib/repo/credentials.ts';
import { getInstanceSettings } from '../../../../lib/repo/instance-settings.ts';
import {
  countServersAtAddress,
  getServer,
  listServerHostKeys,
} from '../../../../lib/repo/servers.ts';
import { duplicateServerPath, ROUTES, serverPath } from '../../../../lib/routes.ts';
import { formatEndpoint, formatTarget } from '../../../../lib/servers/target.ts';

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const t = await getTranslations('meta');
  const { user } = await requireSession();
  const server = getServer(getAuthRuntime().db, user.id, (await params).id);
  return { title: server ? server.name : t('servers') };
}

/**
 * A server's page (plan D-29, §8.1 /servers/[id]): edit every field, test the connection, decide
 * on the host keys of its address, find the Termavox sessions left running on it (D-30, SSH
 * only), duplicate it, delete it (refused while sessions from it run).
 */
export default async function ServerPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { user } = await requireSession();
  const { id } = await params;
  const search = await searchParams;
  const { db } = getAuthRuntime();
  const server = getServer(db, user.id, id);
  if (!server) notFound();
  const t = await getTranslations('servers');
  const td = await getTranslations('servers.diagnostics');
  const tr = await getTranslations('servers.remote');
  const back = await backLinkFrom(search.from, user.id);
  const keys = listServerHostKeys(db, user.id, server.id);
  const credentials = listCredentials(db, user.id).map((c) => ({ id: c.id, name: c.name }));
  const local = localKindAvailability(getInstanceSettings(db), user.role);
  const here = serverPath(server.id);
  const ssh =
    server.kind === 'ssh' && server.hostname !== null && server.port !== null
      ? { hostname: server.hostname, port: server.port, username: server.username ?? '' }
      : null;
  // Host-key decisions cover exactly this hostname and port, so the port is always shown here.
  const address = ssh ? formatEndpoint(ssh.hostname, ssh.port) : null;
  const sharing = ssh ? countServersAtAddress(db, user.id, ssh.hostname, ssh.port) : 0;

  return (
    <>
      {back ? (
        <div className="-mb-3 -ms-3">
          <ButtonLink href={back.href} variant="quiet" size="sm" icon={<ArrowLeftIcon size={16} />}>
            {back.label}
          </ButtonLink>
        </div>
      ) : null}
      <PageHeader
        title={server.name}
        meta={<Tag>{t(`kind.${server.kind}`)}</Tag>}
        description={
          ssh ? (
            <span className="break-all font-mono text-sm">
              {formatTarget(ssh.username, ssh.hostname, ssh.port)}
            </span>
          ) : (
            t('list.local')
          )
        }
        actions={
          <ButtonLink
            href={withReturnPath(duplicateServerPath(server.id), here)}
            variant="secondary"
            icon={<CopyIcon size={16} />}
          >
            {t('duplicate')}
          </ButtonLink>
        }
      />
      <DoneNotice
        done={search.done}
        messages={{
          serverSaved: t('notice.serverSaved'),
          keyTrusted: t('notice.keyTrusted'),
          keyPretrusted: t('notice.keyPretrusted'),
          keyReplaced: t('notice.keyReplaced'),
          keyRevoked: t('notice.keyRevoked'),
        }}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:grid-rows-[auto_auto_1fr]">
        <Panel aria-labelledby="server-settings-title" className="lg:col-start-1">
          <PanelSection>
            <SectionHeading
              id="server-settings-title"
              title={t('page.settingsTitle')}
              description={t('page.settingsIntro')}
            />
          </PanelSection>
          <PanelSection ruled>
            <ServerForm
              serverId={server.id}
              initial={{
                name: server.name,
                kind: server.kind,
                hostname: server.hostname ?? '',
                port: server.port === null ? '22' : String(server.port),
                username: server.username ?? '',
                credentialId: server.credentialId ?? '',
              }}
              options={{
                protectionMode: server.protectionMode,
                startupCommand: server.startupCommand ?? '',
                env: Object.entries(server.env).map(([key, value]) => ({ key, value })),
                keepaliveIntervalS: server.keepaliveIntervalS,
                autoReopen: server.autoReopen,
                scrollbackLines: server.scrollbackLines,
              }}
              credentials={credentials}
              localAllowed={local.allowed}
              localReason={local.reason ? t(`form.localReason.${local.reason}`) : null}
            />
          </PanelSection>
        </Panel>

        <Panel
          aria-labelledby="diagnostics-title"
          className="lg:col-start-2 lg:row-span-3 lg:row-start-1"
        >
          <span id="diagnostics" className="sr-only" />
          <PanelSection>
            <SectionHeading id="diagnostics-title" title={td('title')} description={td('intro')} />
          </PanelSection>
          {ssh && address ? (
            <>
              <PanelSection ruled>
                <TestConnection
                  serverId={server.id}
                  hostname={ssh.hostname}
                  hasCredential={server.credentialId !== null}
                />
              </PanelSection>
              <PanelSection ruled className="flex flex-col gap-3">
                <h3 className="font-semibold text-ink text-md">{td('keys.title', { address })}</h3>
                <Notice tone="info">{td('keys.shared', { count: sharing, address })}</Notice>
                {keys.length === 0 ? (
                  <p className="text-pretty text-base text-ink-muted">{td('keys.empty')}</p>
                ) : (
                  <ul className="flex flex-col border-line border-y">
                    {keys.map((key) => (
                      <li
                        key={key.id}
                        className="flex flex-col gap-2 border-line border-t py-3 first:border-t-0"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink text-sm">{key.keyType}</span>
                          <Tag
                            tone={
                              key.status === 'trusted'
                                ? 'success'
                                : key.status === 'pending'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {td(`status.${key.status}`)}
                          </Tag>
                        </div>
                        <FingerprintText value={key.fingerprint} />
                        <p className="text-ink-muted text-sm">
                          {key.status === 'pending' ? td('keys.seen') : td('keys.decided')}{' '}
                          <LocalTime at={key.decidedAt ?? key.firstSeenAt} />
                        </p>
                        {key.status === 'pending' ? (
                          <TrustKeyButton
                            serverId={server.id}
                            keyType={key.keyType}
                            fingerprint={key.fingerprint}
                            label={td('trust')}
                          />
                        ) : null}
                        {key.status === 'trusted' ? (
                          <div className="flex flex-col gap-3">
                            <details className="group/disclosure">
                              <DisclosureSummary className="font-medium text-ink text-sm">
                                {td('replace.title')}
                              </DisclosureSummary>
                              <div className="mt-3 rounded-control border border-line bg-surface px-4 py-3">
                                <ReplaceKeyForm
                                  serverId={server.id}
                                  hostname={ssh.hostname}
                                  keyType={key.keyType}
                                />
                              </div>
                            </details>
                            <ConfirmAction
                              label={td('revoke.label')}
                              question={td('revoke.question', { keyType: key.keyType, address })}
                              confirmLabel={td('revoke.confirm')}
                              action={revokeHostKey}
                              hidden={{ serverId: server.id, keyType: key.keyType }}
                              isolated={false}
                            />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </PanelSection>
              <PanelSection ruled>
                <details className="group/disclosure">
                  <DisclosureSummary className="font-semibold text-ink text-md">
                    {td('pretrust.title')}
                  </DisclosureSummary>
                  <div className="mt-3">
                    <PretrustForm serverId={server.id} />
                  </div>
                </details>
              </PanelSection>
            </>
          ) : (
            <PanelSection ruled>
              <p className="text-pretty text-base text-ink-muted">{td('localOnly')}</p>
            </PanelSection>
          )}
        </Panel>

        {ssh ? (
          <Panel aria-labelledby="remote-sessions-title" className="lg:col-start-1">
            <span id="remote-sessions" className="sr-only" />
            <PanelSection>
              <SectionHeading
                id="remote-sessions-title"
                title={tr('title')}
                description={
                  <>
                    {tr.rich('intro', {
                      target: `${ssh.username}@${formatEndpoint(ssh.hostname, ssh.port)}`,
                      mono: (chunks) => (
                        <span className="break-all font-mono text-sm">{chunks}</span>
                      ),
                    })}{' '}
                    <LearnMore section="remote-sessions" />
                  </>
                }
              />
            </PanelSection>
            <PanelSection ruled>
              <RemoteSessions serverId={server.id} username={ssh.username} />
            </PanelSection>
          </Panel>
        ) : null}

        <Panel aria-labelledby="server-delete-title" className="lg:col-start-1">
          <PanelSection className="flex flex-col gap-3">
            <h2 id="server-delete-title" className="font-semibold text-ink text-md">
              {t('delete.title')}
            </h2>
            <p className="max-w-[60ch] text-pretty text-base text-ink-muted">
              {server.liveSessionCount > 0
                ? t('delete.blocked', { count: server.liveSessionCount })
                : t('delete.intro')}{' '}
              {server.liveSessionCount > 0 ? (
                <Link
                  href={ROUTES.workspace}
                  className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                >
                  {t('delete.toWorkspace')}
                </Link>
              ) : null}
            </p>
            <ConfirmAction
              label={t('delete.label')}
              question={t('delete.question', { name: server.name })}
              confirmLabel={t('delete.confirm')}
              action={deleteServer}
              hidden={{ id: server.id }}
              isolated={false}
            />
          </PanelSection>
        </Panel>
      </div>
    </>
  );
}
