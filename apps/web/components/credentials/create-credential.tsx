'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useRef, useState } from 'react';
import type { CredentialCreateState, CredentialKind } from '../../lib/actions/credential-states.ts';
import { createCredential } from '../../lib/actions/credentials.ts';
import { installCommand } from '../../lib/manage/install-command.ts';
import { ArrowLeftIcon } from '../icons/index.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { CopyButton } from '../ui/copy-button.tsx';
import { cx } from '../ui/cx.ts';
import { CONTROL_BASE, Field, fieldIds } from '../ui/field.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { radioClasses } from '../ui/radio.ts';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';
import { useKeepChoicesOnReset } from '../ui/use-keep-choices.ts';

const KINDS: CredentialKind[] = ['generate', 'private_key', 'password'];

/**
 * New credential: generate an ed25519 key (recommended; the public key is shown once), paste a
 * private key (optional passphrase), or store a password. Secrets go to the session service and
 * are never shown again, nor echoed back after a failed submit. With `back` (the page that sent
 * the user here, plan D-27), the success state leads back there first.
 */
export function CreateCredential({ back }: { back?: { href: string; label: string } | null }) {
  const t = useTranslations('credentials.create');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(createCredential, {} as CredentialCreateState);
  const formRef = useRef<HTMLFormElement>(null);
  useKeepChoicesOnReset(formRef);
  const [kind, setKind] = useState<CredentialKind>(
    (state.values?.kind as CredentialKind | undefined) ?? 'generate',
  );
  const [dismissed, setDismissed] = useState<number | undefined>(undefined);
  const errorPrefix = tf('errorPrefix');
  const created = state.created && dismissed !== state.savedAt ? state.created : null;

  if (created) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="success" title={t('done.title', { name: created.name })}>
          {created.kind === 'generate' ? t('done.generated') : t('done.stored')}
        </Notice>
        {created.publicKey ? (
          <>
            <div className="flex flex-col gap-2">
              <p className="font-semibold text-ink text-sm">{t('done.publicKey')}</p>
              <pre className="whitespace-pre-wrap break-all rounded-control bg-field px-3 py-2.5 font-mono text-ink text-sm">
                {created.publicKey}
              </pre>
              <CopyButton value={created.publicKey} label={t('done.copyKey')} />
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-semibold text-ink text-sm">{t('done.command')}</p>
              <pre className="whitespace-pre-wrap break-all rounded-control bg-field px-3 py-2.5 font-mono text-ink text-sm">
                {installCommand(created.publicKey)}
              </pre>
              <CopyButton value={installCommand(created.publicKey)} label={t('done.copyCommand')} />
            </div>
            <p className="text-pretty text-ink-muted text-sm">{t('done.once')}</p>
          </>
        ) : null}
        {created.fingerprint ? (
          <p className="text-ink-muted text-sm">
            {t('done.fingerprint')}{' '}
            <code className="break-all font-mono text-ink">{created.fingerprint}</code>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {back ? (
            <ButtonLink
              href={back.href}
              variant="primary"
              size="lg"
              icon={<ArrowLeftIcon size={18} />}
            >
              {back.label}
            </ButtonLink>
          ) : null}
          <Button
            variant="secondary"
            size={back ? 'lg' : 'md'}
            onClick={() => setDismissed(state.savedAt)}
          >
            {t('done.another')}
          </Button>
        </div>
      </div>
    );
  }

  const privateKeyId = 'credential-private-key';
  const keyIds = fieldIds(privateKeyId, t('privateKeyHelp'), state.fields?.privateKey);
  return (
    <form
      ref={formRef}
      action={action}
      noValidate
      className="flex flex-col gap-5"
      autoComplete="off"
    >
      <FormMessage message={state.message} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 font-semibold text-ink text-sm">{t('kind')}</legend>
        <div className="flex flex-col gap-2">
          {KINDS.map((value) => (
            <label
              key={value}
              className={cx(
                'flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2.5',
                'transition-colors duration-(--duration-step) ease-(--ease-out)',
                'has-focus-visible:outline-2 has-focus-visible:outline-focus has-focus-visible:outline-offset-2',
                kind === value
                  ? 'border-accent-ring bg-accent-soft'
                  : 'border-line hover:bg-surface-raised',
              )}
            >
              <input
                type="radio"
                name="kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                className={radioClasses('sm')}
              />
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-base text-ink">{t(`kinds.${value}`)}</span>
                <span className="text-ink-muted text-sm">{t(`kindHelp.${value}`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <TextField
        name="name"
        label={t('name')}
        help={t('nameHelp')}
        defaultValue={state.values?.name ?? ''}
        error={state.fields?.name}
        errorPrefix={errorPrefix}
        required
        maxLength={120}
      />
      {kind === 'password' ? (
        <PasswordField
          name="password"
          label={t('password')}
          help={t('passwordHelp')}
          error={state.fields?.password}
          errorPrefix={errorPrefix}
          autoComplete="new-password"
          required
        />
      ) : null}
      {kind === 'private_key' ? (
        <>
          <Field
            id={privateKeyId}
            label={t('privateKey')}
            help={t('privateKeyHelp')}
            error={state.fields?.privateKey}
            errorPrefix={errorPrefix}
          >
            <textarea
              id={privateKeyId}
              name="privateKey"
              rows={7}
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={state.fields?.privateKey ? true : undefined}
              aria-describedby={keyIds.describedBy}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className={cx(CONTROL_BASE, 'resize-y px-3 py-2.5 font-mono text-sm leading-5')}
            />
          </Field>
          <PasswordField
            name="passphrase"
            label={t('passphrase')}
            help={t('passphraseHelp')}
            autoComplete="off"
          />
        </>
      ) : null}
      {kind === 'generate' ? (
        <p className="text-pretty text-base text-ink-muted">{t('generateNote')}</p>
      ) : null}
      <div>
        <SubmitButton size="lg">{t(`submit.${kind}`)}</SubmitButton>
      </div>
    </form>
  );
}
