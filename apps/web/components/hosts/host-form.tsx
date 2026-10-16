'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { saveHost } from '../../lib/actions/hosts.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import type { HostKind } from '../../lib/repo/hosts.ts';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { radioClasses } from '../ui/radio.ts';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

export interface HostFormValues {
  id?: string;
  name: string;
  kind: HostKind;
  hostname: string;
  port: string;
}

/**
 * Create or edit a host. The local (direct-mode) kind is offered only when an admin turned it on
 * and the user is an admin; otherwise it is shown disabled with the reason.
 */
export function HostForm({
  initial,
  localAllowed,
  localReason,
  submitLabel,
}: {
  initial: HostFormValues;
  localAllowed: boolean;
  /** Why the local kind is unavailable (shown under the disabled option). */
  localReason: string | null;
  submitLabel: string;
}) {
  const t = useTranslations('hosts.form');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(saveHost, {} as ManageState);
  const values = state.values ?? {};
  const [kind, setKind] = useState<HostKind>((values.kind as HostKind) ?? initial.kind);
  const errorPrefix = tf('errorPrefix');
  const v = (name: keyof HostFormValues) => values[name] ?? (initial[name] as string) ?? '';

  return (
    <form action={action} noValidate className="flex flex-col gap-5" key={state.savedAt}>
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <FormMessage message={state.message} />
      {state.notice ? <Notice tone="success">{state.notice}</Notice> : null}
      <TextField
        name="name"
        label={t('name')}
        help={t('nameHelp')}
        defaultValue={v('name')}
        error={state.fields?.name}
        errorPrefix={errorPrefix}
        required
        maxLength={80}
        autoComplete="off"
      />
      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-1.5 font-semibold text-ink text-sm">{t('kind')}</legend>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="radio"
            name="kind"
            value="ssh"
            checked={kind === 'ssh'}
            onChange={() => setKind('ssh')}
            className={radioClasses('md', 'mt-0.5')}
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-base text-ink">{t('kindSsh')}</span>
            <span className="text-ink-muted text-sm">{t('kindSshHelp')}</span>
          </span>
        </label>
        <label
          className={
            localAllowed ? 'flex cursor-pointer items-start gap-3' : 'flex items-start gap-3'
          }
        >
          <input
            type="radio"
            name="kind"
            value="local"
            checked={kind === 'local'}
            disabled={!localAllowed}
            onChange={() => setKind('local')}
            aria-describedby="host-kind-local-help"
            className={radioClasses('md', 'mt-0.5')}
          />
          <span className="flex flex-col gap-0.5">
            <span
              className={
                localAllowed
                  ? 'font-medium text-base text-ink'
                  : 'font-medium text-base text-ink-faint'
              }
            >
              {t('kindLocal')}
            </span>
            <span id="host-kind-local-help" className="text-ink-muted text-sm">
              {localReason ?? t('kindLocalHelp')}
            </span>
          </span>
        </label>
        {state.fields?.kind ? (
          <p className="font-medium text-danger text-sm">{state.fields.kind}</p>
        ) : null}
      </fieldset>
      {kind === 'ssh' ? (
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <TextField
            name="hostname"
            label={t('hostname')}
            help={t('hostnameHelp')}
            defaultValue={v('hostname')}
            error={state.fields?.hostname}
            errorPrefix={errorPrefix}
            required
            maxLength={253}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <TextField
            name="port"
            label={t('port')}
            defaultValue={v('port') || '22'}
            error={state.fields?.port}
            errorPrefix={errorPrefix}
            inputMode="numeric"
            required
            className="tabular-nums"
          />
        </div>
      ) : null}
      <div>
        <SubmitButton size="lg">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
