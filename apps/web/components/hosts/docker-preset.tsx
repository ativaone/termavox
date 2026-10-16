'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { DOCKER_HOSTNAME, type DockerPresetState } from '../../lib/actions/host-states.ts';
import { addDockerHost } from '../../lib/actions/hosts.ts';
import { ArrowRightIcon } from '../icons/index.tsx';
import { buttonClasses } from '../ui/button.tsx';
import { CopyButton } from '../ui/copy-button.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

/** The shell command that installs the key for the host user (single-quoted, POSIX sh). */
function installCommand(publicKey: string): string {
  const quoted = `'${publicKey.replaceAll("'", `'\\''`)}'`;
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' ${quoted} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

function CodeWell({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-semibold text-ink text-sm">{label}</p>
      <pre className="whitespace-pre-wrap break-all rounded-control bg-field px-3 py-2.5 font-mono text-ink text-sm">
        {value}
      </pre>
      <CopyButton value={value} label={copyLabel} />
    </div>
  );
}

/**
 * "Add this Docker host" (plan §13.4): one field (the user on the Docker host), then the exact
 * `authorized_keys` line and a copy-paste command, shown once. The host's own key is still
 * checked through the normal trust flow on the host page.
 */
export function DockerPreset() {
  const t = useTranslations('hosts.docker');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(addDockerHost, {} as DockerPresetState);

  if (state.created) {
    const { hostId, publicKey, fingerprint, username } = state.created;
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
              href={`/hosts/${encodeURIComponent(hostId)}#diagnostics`}
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
        <li>{t('creates.host', { hostname: DOCKER_HOSTNAME })}</li>
        <li>{t('creates.key')}</li>
        <li>{t('creates.profile')}</li>
      </ul>
      <div>
        <SubmitButton size="lg">{t('submit')}</SubmitButton>
      </div>
    </form>
  );
}
