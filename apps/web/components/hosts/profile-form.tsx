'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useId, useState } from 'react';
import { saveProfile } from '../../lib/actions/hosts.ts';
import {
  ENV_MAX,
  KEEPALIVE_MAX,
  KEEPALIVE_MIN,
  type ManageState,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
} from '../../lib/manage/forms.ts';
import { withReturnPath } from '../../lib/manage/return-to.ts';
import { ROUTES } from '../../lib/routes.ts';
import { CloseIcon, PlusIcon } from '../icons/index.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { FieldError } from '../ui/field.tsx';
import { FormMessage } from '../ui/notice.tsx';
import { radioClasses } from '../ui/radio.ts';
import { Select } from '../ui/select.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

export interface ProfileFormValues {
  id?: string;
  name: string;
  username: string;
  credentialId: string;
  protectionMode: 'auto' | 'off';
  startupCommand: string;
  env: Array<{ key: string; value: string }>;
  keepaliveIntervalS: number;
  autoReopen: boolean;
  scrollbackLines: number;
}

/** A new profile's behaviour (the host page and "Add server" share these defaults). */
export const PROFILE_DEFAULTS: ProfileOptionsValues = {
  protectionMode: 'auto',
  startupCommand: '',
  env: [],
  keepaliveIntervalS: 15,
  autoReopen: true,
  scrollbackLines: 5000,
};

export type ProfileOptionsValues = Pick<
  ProfileFormValues,
  | 'protectionMode'
  | 'startupCommand'
  | 'env'
  | 'keepaliveIntervalS'
  | 'autoReopen'
  | 'scrollbackLines'
>;

interface EnvRow {
  id: number;
  key: string;
  value: string;
}

let nextRowId = 1;
const toRows = (env: Array<{ key: string; value: string }>): EnvRow[] =>
  env.map((pair) => ({ id: nextRowId++, ...pair }));

function parseEnvValue(json: string | undefined): Array<{ key: string; value: string }> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as Array<{ key: string; value: string }>) : null;
  } catch {
    return null;
  }
}

/** Environment variables as key/value rows (sent as parallel `envKey` / `envValue` fields). */
function EnvEditor({
  initial,
  prefix,
  error,
  errorPrefix,
}: {
  initial: Array<{ key: string; value: string }>;
  prefix: string;
  error?: string;
  errorPrefix: string;
}) {
  const t = useTranslations('hosts.profile.form');
  const [rows, setRows] = useState<EnvRow[]>(() => toRows(initial));
  const legendId = useId();
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={`${legendId}-help`}>
      <legend id={legendId} className="mb-1 font-semibold text-ink text-sm">
        {t('env')}
      </legend>
      <p id={`${legendId}-help`} className="text-ink-muted text-sm">
        {t('envHelp')}
      </p>
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <li key={row.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2.75rem] gap-2">
              <input
                name={`${prefix}envKey`}
                aria-label={t('envKey', { n: index + 1 })}
                placeholder={t('envKeyPlaceholder')}
                defaultValue={row.key}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="h-11 min-w-0 rounded-control border border-line-strong bg-field px-3 font-mono text-ink text-md placeholder:text-ink-muted focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1"
              />
              <input
                name={`${prefix}envValue`}
                aria-label={t('envValue', { n: index + 1 })}
                placeholder={t('envValuePlaceholder')}
                defaultValue={row.value}
                autoComplete="off"
                spellCheck={false}
                className="h-11 min-w-0 rounded-control border border-line-strong bg-field px-3 font-mono text-ink text-md placeholder:text-ink-muted focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1"
              />
              <Button
                variant="quiet"
                size="lg"
                iconOnly
                aria-label={t('envRemove', { n: index + 1 })}
                title={t('envRemove', { n: index + 1 })}
                onClick={() => setRows((all) => all.filter((r) => r.id !== row.id))}
                icon={<CloseIcon size={16} />}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <FieldError prefix={errorPrefix} message={error} /> : null}
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={rows.length >= ENV_MAX}
          onClick={() => setRows((all) => [...all, { id: nextRowId++, key: '', value: '' }])}
          icon={<PlusIcon size={16} />}
        >
          {t('envAdd')}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * How sessions from a profile behave: tmux protection, startup command, environment, keepalive,
 * scrollback and auto-reopen, as three hairline-divided groups. Shared by the profile form on
 * the host page and the "Advanced" disclosure of "Add server", whose inputs carry a `prefix`.
 * `values` (echoed after a failed submit) and `fields` (errors) use the prefixed names.
 */
export function ProfileOptionsFields({
  initial,
  values,
  fields,
  errorPrefix,
  prefix = '',
}: {
  initial: ProfileOptionsValues;
  values: Record<string, string>;
  fields?: Record<string, string>;
  errorPrefix: string;
  prefix?: string;
}) {
  const t = useTranslations('hosts.profile.form');
  const n = (name: string) => `${prefix}${name}`;
  const str = (name: string, fallback: string | number) =>
    values[n(name)] !== undefined ? (values[n(name)] as string) : String(fallback);
  const [mode, setMode] = useState<'auto' | 'off'>(
    values[n('protectionMode')] === 'off' || values[n('protectionMode')] === 'auto'
      ? (values[n('protectionMode')] as 'auto' | 'off')
      : initial.protectionMode,
  );
  const echoedEnv = values[n('env')];
  const env = parseEnvValue(echoedEnv) ?? initial.env;

  return (
    <>
      <fieldset className="flex flex-col gap-2.5 border-line border-t pt-5">
        <legend className="float-left mb-2 w-full font-semibold text-ink text-sm">
          {t('protection')}
        </legend>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="radio"
            name={n('protectionMode')}
            value="auto"
            checked={mode === 'auto'}
            onChange={() => setMode('auto')}
            className={radioClasses('md', 'mt-0.5')}
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-base text-ink">{t('protectionAuto')}</span>
            <span className="max-w-[60ch] text-ink-muted text-sm">{t('protectionAutoHelp')}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="radio"
            name={n('protectionMode')}
            value="off"
            checked={mode === 'off'}
            onChange={() => setMode('off')}
            className={radioClasses('md', 'mt-0.5')}
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-base text-ink">{t('protectionOff')}</span>
            <span className="max-w-[60ch] text-ink-muted text-sm">{t('protectionOffHelp')}</span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-col gap-5 border-line border-t pt-5">
        <TextField
          name={n('startupCommand')}
          label={t('startup')}
          help={t('startupHelp')}
          defaultValue={str('startupCommand', initial.startupCommand)}
          error={fields?.[n('startupCommand')]}
          errorPrefix={errorPrefix}
          maxLength={1000}
          mono
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <EnvEditor
          key={echoedEnv ?? 'initial'}
          initial={env}
          prefix={prefix}
          error={fields?.[n('env')]}
          errorPrefix={errorPrefix}
        />
      </div>

      <div className="grid gap-5 border-line border-t pt-5 sm:grid-cols-2">
        <TextField
          name={n('keepaliveIntervalS')}
          label={t('keepalive')}
          help={t('keepaliveHelp', { min: KEEPALIVE_MIN, max: KEEPALIVE_MAX })}
          defaultValue={str('keepaliveIntervalS', initial.keepaliveIntervalS)}
          error={fields?.[n('keepaliveIntervalS')]}
          errorPrefix={errorPrefix}
          inputMode="numeric"
          className="tabular-nums"
        />
        <TextField
          name={n('scrollbackLines')}
          label={t('scrollback')}
          help={t('scrollbackHelp', { min: SCROLLBACK_MIN, max: SCROLLBACK_MAX })}
          defaultValue={str('scrollbackLines', initial.scrollbackLines)}
          error={fields?.[n('scrollbackLines')]}
          errorPrefix={errorPrefix}
          inputMode="numeric"
          className="tabular-nums"
        />
        <Checkbox
          name={n('autoReopen')}
          label={t('autoReopen')}
          help={t('autoReopenHelp')}
          defaultChecked={
            values[n('autoReopen')] !== undefined
              ? values[n('autoReopen')] === 'on'
              : initial.autoReopen
          }
          className="sm:col-span-2"
        />
      </div>
    </>
  );
}

/**
 * Create or edit a connection profile: who to log in as, with which credential, and how the
 * session behaves (tmux protection, startup command, environment, keepalive, auto-reopen,
 * scrollback). Edits apply to new sessions; running ones keep what they started with.
 */
export function ProfileForm({
  hostId,
  initial,
  credentials,
  cancelHref,
}: {
  hostId: string;
  initial: ProfileFormValues;
  credentials: Array<{ id: string; name: string }>;
  cancelHref: string;
}) {
  const t = useTranslations('hosts.profile.form');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(saveProfile, {} as ManageState);
  const errorPrefix = tf('errorPrefix');
  const values = state.values ?? {};
  const str = (name: string, fallback: string | number) =>
    values[name] !== undefined ? values[name] : String(fallback);

  return (
    <form action={action} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="hostId" value={hostId} />
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <FormMessage message={state.message} />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          name="name"
          label={t('name')}
          help={t('nameHelp')}
          defaultValue={str('name', initial.name)}
          error={state.fields?.name}
          errorPrefix={errorPrefix}
          required
          maxLength={80}
          autoComplete="off"
        />
        <TextField
          name="username"
          label={t('username')}
          help={t('usernameHelp')}
          defaultValue={str('username', initial.username)}
          error={state.fields?.username}
          errorPrefix={errorPrefix}
          required
          maxLength={64}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Select
          name="credentialId"
          label={t('credential')}
          defaultValue={str('credentialId', initial.credentialId)}
          error={state.fields?.credentialId}
          errorPrefix={errorPrefix}
          options={[
            { value: '', label: t('credentialNone') },
            ...credentials.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <p className="text-ink-muted text-sm">
          {credentials.length === 0 ? t('credentialEmpty') : t('credentialHelp')}{' '}
          {/* Comes back here afterwards (plan D-27); the select then lists the new credential. */}
          <Link
            href={withReturnPath(ROUTES.credentials, `${ROUTES.hosts}/${hostId}`)}
            className="inline-flex items-center gap-1 font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
          >
            {t('credentialNew')}
          </Link>
        </p>
      </div>

      <ProfileOptionsFields
        initial={initial}
        values={values}
        fields={state.fields}
        errorPrefix={errorPrefix}
      />

      <div className="flex flex-wrap items-center gap-2 border-line border-t pt-5">
        <SubmitButton size="lg">{initial.id ? t('save') : t('create')}</SubmitButton>
        <ButtonLink href={cancelHref} variant="quiet" size="lg" scroll={false}>
          {t('cancel')}
        </ButtonLink>
      </div>
    </form>
  );
}
