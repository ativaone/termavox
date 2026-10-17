'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { DOCKER_HOSTNAME, type DockerPresetState } from '../../lib/actions/server-states.ts';
import { addDockerServer } from '../../lib/actions/servers.ts';
import { installCommand } from '../../lib/manage/install-command.ts';
import { serverPath } from '../../lib/routes.ts';
import { ArrowRightIcon } from '../icons/index.tsx';
import { buttonClasses } from '../ui/button.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';
import { CodeWell } from './add-server-result.tsx';

/**
 * "Add this Docker host" (plan §13.4): one field (the user on the machine that runs Docker), then
 * the exact `authorized_keys` line and a copy-paste command, shown once. The machine's own host
 * key is still checked through the normal trust flow on the server page.
 */
export function DockerPreset() {
  const t = useTranslations('servers.docker');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(addDockerServer, {} as DockerPresetState);

  if (state.created) {
    const { serverId, publicKey, fingerprint, username } = state.created;
    return (
      <div className="flex flex-col gap-5">
        <Notice tone="success" title={t('done.title')}>
          {t('done.body', { username, hostname: DOCKER_HOSTNAME })}
        </Notice>
        <ol className="flex flex-col gap-5">
          <li className="flex flex-col gap-3">
            <h3 className="font-semibold text-ink text-md">{t('done.step1')}</h3>
            <CodeWell
              label={t('done.command')}
              value={installCommand(publicKey)}
              copyLabel={t('done.copyCommand')}
            />
            <CodeWell label={t('done.line')} value={publicKey} copyLabel={t('done.copyLine')} />
            {fingerprint ? (
              <p className="text-ink-muted text-sm">
                {t('done.fingerprint')}{' '}
                <code className="break-all font-mono text-ink">{fingerprint}</code>
              </p>
            ) : null}
            <p className="text-pretty text-ink-muted text-sm">{t('done.once')}</p>
          </li>
          <li className="flex flex-col gap-2 border-line border-t pt-5">
            <h3 className="font-semibold text-ink text-md">{t('done.step2')}</h3>
            <p className="max-w-[60ch] text-pretty text-base text-ink-muted">{t('done.sshd')}</p>
          </li>
          <li className="flex flex-col items-start gap-3 border-line border-t pt-5">
            <h3 className="font-semibold text-ink text-md">{t('done.step3')}</h3>
            <p className="max-w-[60ch] text-pretty text-base text-ink-muted">{t('done.verify')}</p>
            <Link
              href={`${serverPath(serverId)}#diagnostics`}
              className={buttonClasses({ variant: 'primary', size: 'lg' })}
            >
              {t('done.open')}
              <ArrowRightIcon size={18} />
            </Link>
          </li>
        </ol>
      </div>
    );
  }

  return (
    <form action={action} noValidate className="flex flex-col gap-5">
      <FormMessage message={state.message} />
      <TextField
        name="username"
        label={t('username')}
        help={t('usernameHelp')}
        defaultValue={state.values?.username ?? ''}
        error={state.fields?.username}
        errorPrefix={tf('errorPrefix')}
        required
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={32}
      />
      <ul className="flex flex-col gap-1.5 border-line border-y py-3 text-base text-ink">
        <li>{t('creates.server', { hostname: DOCKER_HOSTNAME })}</li>
        <li>{t('creates.key')}</li>
      </ul>
      <div>
        <SubmitButton size="lg">{t('submit')}</SubmitButton>
      </div>
    </form>
  );
}
