import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CreateCredential } from '../../../components/credentials/create-credential.tsx';
import { RenameCredential } from '../../../components/credentials/rename-credential.tsx';
import { ArrowLeftIcon, KeyIcon } from '../../../components/icons/index.tsx';
import { DoneNotice, param } from '../../../components/manage/done-notice.tsx';
import { ButtonLink } from '../../../components/ui/button.tsx';
import { ConfirmAction } from '../../../components/ui/confirm-action.tsx';
import { DataTable, Td, Th, Tr } from '../../../components/ui/data-table.tsx';
import { LocalTime } from '../../../components/ui/local-time.tsx';
import { PageHeader, SectionHeading } from '../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../components/ui/panel.tsx';
import { Tag } from '../../../components/ui/tag.tsx';
import { deleteCredential } from '../../../lib/actions/credentials.ts';
import { getAuthRuntime, requireSession } from '../../../lib/auth/server.ts';
import { backLinkFrom } from '../../../lib/manage/back-link.ts';
import { listCredentials } from '../../../lib/repo/credentials.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('credentials') };
}

/** Credentials (plan §8.1): list with fingerprints, create, rename, delete. */
export default async function CredentialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const t = await getTranslations('credentials');
  const credentials = listCredentials(getAuthRuntime().db, user.id);
  const search = await searchParams;
  const renaming = param(search.rename);
  // Reached from another page (e.g. a server's page): offer the way back there (D-27).
  const back = await backLinkFrom(search.from, user.id);

  return (
    <>
      {back ? (
        <div className="-mb-3 -ms-3">
          <ButtonLink href={back.href} variant="quiet" size="sm" icon={<ArrowLeftIcon size={16} />}>
            {back.label}
          </ButtonLink>
        </div>
      ) : null}
      <PageHeader title={t('title')} description={t('intro')} />
      <DoneNotice
        done={search.done}
        messages={{ renamed: t('notice.renamed'), deleted: t('notice.deleted') }}
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)]">
        <Panel aria-labelledby="credentials-list-title">
          <PanelSection>
            <SectionHeading id="credentials-list-title" title={t('list.title')} />
          </PanelSection>
          {credentials.length === 0 ? (
            <PanelSection ruled>
              <div className="flex items-start gap-3">
                <KeyIcon size={24} className="mt-0.5 shrink-0 text-ink-muted" />
                <p className="max-w-[56ch] text-pretty text-base text-ink-muted">
                  {t('list.empty')}
                </p>
              </div>
            </PanelSection>
          ) : (
            <div className="border-line border-t">
              <DataTable
                caption={t('list.title')}
                head={
                  <>
                    <Th>{t('list.name')}</Th>
                    <Th>{t('list.kind')}</Th>
                    <Th>{t('list.lastUsed')}</Th>
                    <Th>
                      <span className="sr-only">{t('list.actions')}</span>
                    </Th>
                  </>
                }
              >
                {credentials.map((credential) => (
                  <Tr key={credential.id}>
                    <Td primary className="md:w-[45%] md:max-w-0">
                      {renaming === credential.id ? (
                        <RenameCredential id={credential.id} name={credential.name} />
                      ) : (
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="break-words font-semibold">{credential.name}</span>
                          {credential.fingerprint ? (
                            <code className="break-all font-mono text-ink-muted text-xs">
                              {credential.fingerprint}
                            </code>
                          ) : null}
                          <span className="text-ink-muted text-sm">
                            {t('list.usedBy', { count: credential.serverCount })}
                          </span>
                        </span>
                      )}
                    </Td>
                    <Td label={t('list.kind')}>
                      <Tag>{t(`kind.${credential.kind}`)}</Tag>
                    </Td>
                    {/* One line on wide screens: the actions row must not squeeze it to three. */}
                    <Td label={t('list.lastUsed')} className="text-ink-muted md:whitespace-nowrap">
                      {credential.lastUsedAt ? (
                        <LocalTime at={credential.lastUsedAt} />
                      ) : (
                        t('list.never')
                      )}
                    </Td>
                    <Td className="max-md:pt-2">
                      {/* One row: Delete keeps its 2rem isolation beside Rename (no 8 px stack). */}
                      <div className="flex flex-wrap items-start justify-end gap-x-2 gap-y-8 max-md:justify-start md:flex-nowrap">
                        {renaming === credential.id ? null : (
                          <ButtonLink
                            href={`/credentials?rename=${encodeURIComponent(credential.id)}`}
                            variant="secondary"
                            size="sm"
                            scroll={false}
                          >
                            {t('list.rename')}
                          </ButtonLink>
                        )}
                        <ConfirmAction
                          label={t('list.delete')}
                          question={t('list.deleteQuestion', { name: credential.name })}
                          confirmLabel={t('list.deleteConfirm')}
                          action={deleteCredential}
                          hidden={{ id: credential.id }}
                        />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </DataTable>
            </div>
          )}
        </Panel>
        <Panel aria-labelledby="credentials-create-title">
          <PanelSection>
            <SectionHeading
              id="credentials-create-title"
              title={t('create.title')}
              description={t('create.intro')}
            />
          </PanelSection>
          <PanelSection ruled>
            <CreateCredential back={back} />
          </PanelSection>
        </Panel>
      </div>
    </>
  );
}
