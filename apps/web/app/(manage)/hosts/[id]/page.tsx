import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  FetchVerify,
  FingerprintText,
  PretrustForm,
  ReplaceKeyForm,
  TrustKeyButton,
} from '../../../../components/hosts/diagnostics.tsx';
import { HostForm } from '../../../../components/hosts/host-form.tsx';
import { ProfileForm, type ProfileFormValues } from '../../../../components/hosts/profile-form.tsx';
import { PlusIcon } from '../../../../components/icons/index.tsx';
import { DoneNotice, param } from '../../../../components/manage/done-notice.tsx';
import { ButtonLink } from '../../../../components/ui/button.tsx';
import { ConfirmAction } from '../../../../components/ui/confirm-action.tsx';
import { LocalTime } from '../../../../components/ui/local-time.tsx';
import { PageHeader, SheetHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { SheetTable, Td, Th, Tr } from '../../../../components/ui/sheet-table.tsx';
import { Tag } from '../../../../components/ui/tag.tsx';
import { deleteHost, deleteProfile, revokeHostKey } from '../../../../lib/actions/hosts.ts';
import { getAuthRuntime, requireSession } from '../../../../lib/auth/server.ts';
import { localKindAvailability } from '../../../../lib/manage/local-kind.ts';
import { listCredentials } from '../../../../lib/repo/credentials.ts';
import { getHost, listHostKeys } from '../../../../lib/repo/hosts.ts';
import { getInstanceSettings } from '../../../../lib/repo/instance-settings.ts';
import { listProfiles, type Profile } from '../../../../lib/repo/profiles.ts';

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const t = await getTranslations('meta');
  const { user } = await requireSession();
  const host = getHost(getAuthRuntime().db, user.id, (await params).id);
  return { title: host ? host.name : t('hosts') };
}

const NEW_PROFILE: ProfileFormValues = {
  name: '',
  username: '',
  credentialId: '',
  protectionMode: 'auto',
  startupCommand: '',
  env: [],
  keepaliveIntervalS: 15,
  autoReopen: true,
  scrollbackLines: 5000,
};

function formValues(profile: Profile): ProfileFormValues {
  return {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    credentialId: profile.credentialId ?? '',
    protectionMode: profile.protectionMode,
    startupCommand: profile.startupCommand ?? '',
    env: Object.entries(profile.env).map(([key, value]) => ({ key, value })),
    keepaliveIntervalS: profile.keepaliveIntervalS,
    autoReopen: profile.autoReopen,
    scrollbackLines: profile.scrollbackLines,
  };
}

/** Host detail (plan §8.1): connection profiles, diagnostics and host keys, host settings. */
export default async function HostPage({
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
  const host = getHost(db, user.id, id);
  if (!host) notFound();
  const t = await getTranslations('hosts');
  const tp = await getTranslations('hosts.profile');
  const td = await getTranslations('hosts.diagnostics');
  const profiles = listProfiles(db, user.id, host.id);
  const keys = listHostKeys(db, user.id, host.id);
  const credentials = listCredentials(db, user.id).map((c) => ({ id: c.id, name: c.name }));
  const local = localKindAvailability(getInstanceSettings(db), user.role);
  const hostHref = `/hosts/${encodeURIComponent(host.id)}`;
  const editing = param(search.profile);
  const editedProfile = editing ? profiles.find((p) => p.id === editing) : undefined;
  const editInitial: ProfileFormValues | null =
    editing === 'new' ? NEW_PROFILE : editedProfile ? formValues(editedProfile) : null;
  const ssh = host.kind === 'ssh';
  const numbers = new Intl.NumberFormat(await getLocale());

  return (
    <>
      <PageHeader
        title={host.name}
        meta={<Tag>{t(`kind.${host.kind}`)}</Tag>}
        description={ssh ? `${host.hostname}:${host.port}` : t('list.localAddress')}
      />
      <DoneNotice
        done={search.done}
        messages={{
          hostCreated: t('notice.hostCreated'),
          profileCreated: t('notice.profileCreated'),
          profileSaved: t('notice.profileSaved'),
          profileDeleted: t('notice.profileDeleted'),
          keyTrusted: t('notice.keyTrusted'),
          keyPretrusted: t('notice.keyPretrusted'),
          keyReplaced: t('notice.keyReplaced'),
          keyRevoked: t('notice.keyRevoked'),
        }}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:grid-rows-[auto_1fr]">
        <Panel aria-labelledby="profiles-title" className="scroll-mt-6 lg:col-start-1">
          <span id="profiles" className="sr-only" />
          <PanelSection>
            <SheetHeading
              id="profiles-title"
              title={tp('title')}
              description={tp('intro')}
              action={
                profiles.length > 0 && !editInitial ? (
                  <ButtonLink
                    href={`${hostHref}?profile=new#profile-form`}
                    variant="secondary"
                    size="sm"
                    scroll={false}
                    icon={<PlusIcon size={16} />}
                  >
                    {tp('add')}
                  </ButtonLink>
                ) : null
              }
            />
          </PanelSection>
          {editInitial ? (
            <PanelSection ruled className="scroll-mt-6">
              <h3 id="profile-form" className="mb-4 font-semibold text-ink text-md">
                {editInitial.id ? tp('editTitle', { name: editInitial.name }) : tp('newTitle')}
              </h3>
              <ProfileForm
                key={editInitial.id ?? 'new'}
                hostId={host.id}
                initial={editInitial}
                credentials={credentials}
                cancelHref={`${hostHref}#profiles`}
              />
            </PanelSection>
          ) : null}
          {profiles.length === 0 && !editInitial ? (
            <PanelSection ruled>
              <div className="flex flex-col items-start gap-3">
                <p className="max-w-[60ch] text-pretty text-base text-ink-muted">{tp('empty')}</p>
                <ButtonLink
                  href={`${hostHref}?profile=new#profile-form`}
                  variant="primary"
                  scroll={false}
                  icon={<PlusIcon size={16} />}
                >
                  {tp('add')}
                </ButtonLink>
              </div>
            </PanelSection>
          ) : null}
          {profiles.length > 0 ? (
            <div className="border-rule border-t">
              <SheetTable
                caption={tp('title')}
                head={
                  <>
                    <Th>{tp('list.name')}</Th>
                    <Th>{tp('list.login')}</Th>
                    <Th>{tp('list.protection')}</Th>
                    <Th numeric>{tp('list.scrollback')}</Th>
                    <Th>
                      <span className="sr-only">{tp('list.actions')}</span>
                    </Th>
                  </>
                }
              >
                {profiles.map((profile) => (
                  <Tr key={profile.id}>
                    <Td primary>
                      <span className="font-semibold">{profile.name}</span>
                    </Td>
                    <Td label={tp('list.login')}>
                      <span className="flex min-w-0 flex-col">
                        <span className="break-all">{profile.username}</span>
                        <span className="text-ink-muted text-sm">
                          {profile.credentialName ?? tp('list.noCredential')}
                        </span>
                      </span>
                    </Td>
                    <Td label={tp('list.protection')}>
                      <Tag tone={profile.protectionMode === 'auto' ? 'info' : 'neutral'}>
                        {tp(`mode.${profile.protectionMode}`)}
                      </Tag>
                    </Td>
                    <Td label={tp('list.scrollback')} numeric>
                      {numbers.format(profile.scrollbackLines)}
                    </Td>
                    <Td className="max-md:pt-2">
                      <div className="flex flex-wrap items-start justify-end gap-x-2 gap-y-2 max-md:justify-start">
                        <ButtonLink
                          href={`${hostHref}?profile=${encodeURIComponent(profile.id)}#profile-form`}
                          variant="secondary"
                          size="sm"
                          scroll={false}
                        >
                          {tp('edit')}
                        </ButtonLink>
                        <ConfirmAction
                          label={tp('delete')}
                          question={tp('deleteQuestion', { name: profile.name })}
                          confirmLabel={tp('deleteConfirm')}
                          action={deleteProfile}
                          hidden={{ id: profile.id, hostId: host.id }}
                        />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </SheetTable>
            </div>
          ) : null}
        </Panel>

        <Panel
          aria-labelledby="diagnostics-title"
          className="lg:col-start-2 lg:row-span-2 lg:row-start-1"
        >
          <span id="diagnostics" className="sr-only" />
          <PanelSection>
            <SheetHeading id="diagnostics-title" title={td('title')} description={td('intro')} />
          </PanelSection>
          {ssh ? (
            <>
              <PanelSection ruled>
                <FetchVerify
                  hostId={host.id}
                  hostName={host.name}
                  profiles={profiles.map((p) => ({
                    id: p.id,
                    name: p.name,
                    username: p.username,
                  }))}
                />
              </PanelSection>
              <PanelSection ruled>
                <h3 className="mb-3 font-semibold text-ink text-md">{td('keys.title')}</h3>
                {keys.length === 0 ? (
                  <p className="text-pretty text-base text-ink-muted">{td('keys.empty')}</p>
                ) : (
                  <ul className="flex flex-col border-rule border-y">
                    {keys.map((key) => (
                      <li
                        key={key.id}
                        className="flex flex-col gap-2 border-rule border-t py-3 first:border-t-0"
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
                            hostId={host.id}
                            keyType={key.keyType}
                            fingerprint={key.fingerprint}
                            label={td('trust')}
                          />
                        ) : null}
                        {key.status === 'trusted' ? (
                          <div className="flex flex-col gap-3">
                            <details className="group">
                              <summary className="cursor-pointer font-medium text-ink text-sm underline decoration-rule-strong underline-offset-4 hover:decoration-ink">
                                {td('replace.title')}
                              </summary>
                              <div className="mt-3 rounded-control border border-rule-strong px-4 py-3">
                                <ReplaceKeyForm
                                  hostId={host.id}
                                  hostName={host.name}
                                  keyType={key.keyType}
                                />
                              </div>
                            </details>
                            <ConfirmAction
                              label={td('revoke.label')}
                              question={td('revoke.question', { keyType: key.keyType })}
                              confirmLabel={td('revoke.confirm')}
                              action={revokeHostKey}
                              hidden={{ hostId: host.id, keyType: key.keyType }}
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
                <details className="group">
                  <summary className="cursor-pointer font-semibold text-ink text-md">
                    {td('pretrust.title')}
                  </summary>
                  <div className="mt-3">
                    <PretrustForm hostId={host.id} />
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

        <Panel aria-labelledby="host-settings-title" className="lg:col-start-1">
          <PanelSection>
            <SheetHeading
              id="host-settings-title"
              title={t('settings.title')}
              description={t('settings.intro')}
            />
          </PanelSection>
          <PanelSection ruled>
            <HostForm
              initial={{
                id: host.id,
                name: host.name,
                kind: host.kind,
                hostname: host.hostname,
                port: String(host.port),
              }}
              localAllowed={local.allowed || host.kind === 'local'}
              localReason={local.reason ? t(`form.localReason.${local.reason}`) : null}
              submitLabel={t('settings.submit')}
            />
          </PanelSection>
          <PanelSection ruled className="flex flex-col gap-3">
            <h3 className="font-semibold text-ink text-md">{t('delete.title')}</h3>
            <p className="max-w-[60ch] text-pretty text-base text-ink-muted">
              {host.liveSessionCount > 0
                ? t('delete.blocked', { count: host.liveSessionCount })
                : t('delete.intro')}{' '}
              {host.liveSessionCount > 0 ? (
                <Link
                  href="/workspace"
                  className="font-medium text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
                >
                  {t('delete.toWorkspace')}
                </Link>
              ) : null}
            </p>
            <ConfirmAction
              label={t('delete.label')}
              question={t('delete.question', { name: host.name })}
              confirmLabel={t('delete.confirm')}
              action={deleteHost}
              hidden={{ id: host.id }}
              isolated={false}
            />
          </PanelSection>
        </Panel>
      </div>
    </>
  );
}
