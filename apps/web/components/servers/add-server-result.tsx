'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { startAddedServerSession } from '../../lib/actions/add-server.ts';
import type { AddServerResult, StartSessionState } from '../../lib/actions/add-server-states.ts';
import { installCommand } from '../../lib/manage/install-command.ts';
import { serverPath } from '../../lib/routes.ts';
import { ArrowRightIcon, PlayIcon } from '../icons/index.tsx';
import { ButtonLink } from '../ui/button.tsx';
import { CopyButton } from '../ui/copy-button.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { Panel, PanelSection } from '../ui/panel.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';

export function CodeWell({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="font-semibold text-ink text-sm">{label}</p>
      <pre className="whitespace-pre-wrap break-all rounded-control bg-field px-3 py-2.5 font-mono text-ink text-sm">
        {value}
      </pre>
      <CopyButton value={value} label={copyLabel} />
    </div>
  );
}

/**
 * "Server added", in place of the form (plan D-29): what was created; for a generated key the
 * public key, its fingerprint and the command that installs it (shown once), for a pasted key
 * its fingerprint; then "Start a session" (opens it in the workspace, where the first connection
 * asks to trust the host key), the way back to where the user came from, and the server's page.
 */
export function AddServerDone({
  created,
  back,
}: {
  created: AddServerResult;
  back: { href: string; label: string };
}) {
  const t = useTranslations('servers.addServer.done');
  const ts = useTranslations('servers.addServer');
  const [state, start] = useActionState(startAddedServerSession, {} as StartSessionState);
  const credential = created.credential;
  const publicKey = credential?.publicKey ?? null;
  const ssh = created.kind === 'ssh';

  return (
    <Panel aria-label={t('title')} className="w-full max-w-[46rem]">
      <PanelSection className="flex flex-col gap-5">
        <Notice tone="success" title={t('title')}>
          {ssh && created.target
            ? t('body', { server: created.serverName, target: created.target })
            : t('bodyLocal', { server: created.serverName })}
        </Notice>
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-5 gap-y-2.5 text-base">
          <dt className="font-semibold text-ink-muted text-xs leading-5">{ts('server.title')}</dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="break-words font-semibold text-ink">{created.serverName}</span>
            {created.target ? (
              <span className="break-all font-mono text-ink-muted text-sm">{created.target}</span>
            ) : null}
          </dd>
          {credential ? (
            <>
              <dt className="font-semibold text-ink-muted text-xs leading-5">
                {ts('credential.title')}
              </dt>
              <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                {credential.name ? (
                  <span className="break-words text-ink">{credential.name}</span>
                ) : null}
                <span className={credential.name ? 'text-ink-muted text-sm' : 'text-ink'}>
                  {t(`kind.${credential.choice}`)}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
        {credential?.choice === 'private_key' && credential.fingerprint ? (
          <p className="text-ink-muted text-sm">
            {t('fingerprint')}{' '}
            <code className="break-all font-mono text-ink">{credential.fingerprint}</code>
          </p>
        ) : null}
      </PanelSection>

      {publicKey ? (
        <PanelSection ruled className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold text-ink text-md">{t('keyTitle')}</h2>
            <p className="max-w-[60ch] text-pretty text-base text-ink-muted">{t('keyIntro')}</p>
          </div>
          <CodeWell
            label={t('command', { target: created.target ?? '' })}
            value={installCommand(publicKey)}
            copyLabel={t('copyCommand')}
          />
          <CodeWell label={t('publicKey')} value={publicKey} copyLabel={t('copyKey')} />
          {credential?.fingerprint ? (
            <p className="text-ink-muted text-sm">
              {t('fingerprint')}{' '}
              <code className="break-all font-mono text-ink">{credential.fingerprint}</code>
            </p>
          ) : null}
        </PanelSection>
      ) : null}

      <PanelSection ruled className="flex flex-col gap-4">
        {ssh ? (
          <p className="max-w-[60ch] text-pretty text-base text-ink-muted">
            {credential?.choice === 'none' ? t('trustNone') : t('trust')}
          </p>
        ) : null}
        <FormMessage message={state.message} />
        <div className="flex flex-wrap items-center gap-2">
          <form action={start}>
            <input type="hidden" name="serverId" value={created.serverId} />
            <SubmitButton size="lg" icon={<PlayIcon size={18} />}>
              {t('start')}
            </SubmitButton>
          </form>
          <ButtonLink href={back.href} variant="secondary" size="lg">
            {back.label}
          </ButtonLink>
        </div>
        <Link
          href={serverPath(created.serverId)}
          className="inline-flex w-fit items-center gap-1.5 font-medium text-ink text-sm underline decoration-line-strong underline-offset-4 hover:decoration-ink"
        >
          {t('openServer', { server: created.serverName })}
          <ArrowRightIcon size={14} />
        </Link>
      </PanelSection>
    </Panel>
  );
}
