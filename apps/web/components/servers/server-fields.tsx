'use client';

import { useTranslations } from 'next-intl';
import { type ChangeEvent, useId, useState } from 'react';
import {
  ENV_MAX,
  KEEPALIVE_MAX,
  KEEPALIVE_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  SERVER_NAME_MAX,
} from '../../lib/manage/forms.ts';
import type { ServerKind } from '../../lib/repo/servers.ts';
import type { ServerOptionsValues } from '../../lib/servers/options.ts';
import { LearnMore } from '../help-links.tsx';
import { CloseIcon, PlusIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { DisclosureSummary } from '../ui/disclosure-summary.tsx';
import { FieldError } from '../ui/field.tsx';
import { radioClasses } from '../ui/radio.ts';
import { TextField } from '../ui/text-field.tsx';
import { ChoiceCard } from './add-server-section.tsx';

/**
 * The fields of a server (plan D-29), shared by "Add server" and the server page so both read
 * and validate the same way: where it is and as whom (`ServerTargetFields`), and how its
 * sessions behave (`ServerOptionsFields`, inside `AdvancedOptions`). Inputs carry a `prefix`
 * (`server.` on Add server); `values` (echoed after a failed submit, or a duplicate's prefill)
 * and `fields` (errors) use the prefixed names.
 */

/** Option inputs that live in the "Advanced" disclosure (it opens when one of them has an error). */
export const ADVANCED_FIELDS = [
  'protectionMode',
  'startupCommand',
  'env',
  'keepaliveIntervalS',
  'scrollbackLines',
] as const;

interface FieldProps {
  prefix?: string;
  values: Record<string, string>;
  fields?: Record<string, string>;
  errorPrefix: string;
}

/**
 * Name, kind, address, port and the user name on the server. The local (direct-mode) kind is
 * offered only when allowed (or when the server already is one, so it can be switched back);
 * a local server has no address or user name, and a one-line note says why.
 */
export function ServerTargetFields({
  prefix = '',
  values,
  fields,
  errorPrefix,
  kind,
  onKindChange,
  localAllowed,
  localReason,
  onNameChange,
  onUsernameChange,
}: FieldProps & {
  kind: ServerKind;
  onKindChange(kind: ServerKind): void;
  localAllowed: boolean;
  /** Why the local kind is unavailable, shown under its disabled card (the server page). */
  localReason?: string | null;
  onNameChange?(event: ChangeEvent<HTMLInputElement>): void;
  onUsernameChange?(event: ChangeEvent<HTMLInputElement>): void;
}) {
  const t = useTranslations('servers.form');
  const n = (name: string) => `${prefix}${name}`;
  const v = (name: string, fallback = '') => values[n(name)] ?? fallback;
  const showKind = localAllowed || kind === 'local';

  return (
    <>
      <TextField
        name={n('name')}
        label={t('name')}
        help={t('nameHelp')}
        defaultValue={v('name')}
        onChange={onNameChange}
        error={fields?.[n('name')]}
        errorPrefix={errorPrefix}
        required
        maxLength={SERVER_NAME_MAX}
        autoComplete="off"
      />
      {showKind ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 font-semibold text-ink text-sm">{t('kind')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <ChoiceCard
              name={n('kind')}
              value="ssh"
              checked={kind === 'ssh'}
              onChange={() => onKindChange('ssh')}
              title={t('kindSsh')}
              help={t('kindSshHelp')}
            />
            <ChoiceCard
              name={n('kind')}
              value="local"
              checked={kind === 'local'}
              onChange={() => onKindChange('local')}
              title={t('kindLocal')}
              help={(!localAllowed && localReason) || t('kindLocalHelp')}
              disabled={!localAllowed && kind !== 'local'}
            />
          </div>
          {fields?.[n('kind')] ? (
            <FieldError prefix={errorPrefix} message={fields[n('kind')] as string} />
          ) : null}
        </fieldset>
      ) : (
        <input type="hidden" name={n('kind')} value="ssh" />
      )}
      {kind === 'ssh' ? (
        <>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <TextField
              name={n('hostname')}
              label={t('hostname')}
              help={t('hostnameHelp')}
              defaultValue={v('hostname')}
              error={fields?.[n('hostname')]}
              errorPrefix={errorPrefix}
              required
              maxLength={253}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <TextField
              name={n('port')}
              label={t('port')}
              defaultValue={v('port') || '22'}
              error={fields?.[n('port')]}
              errorPrefix={errorPrefix}
              inputMode="numeric"
              required
              className="tabular-nums"
            />
          </div>
          <TextField
            name={n('username')}
            label={t('username')}
            help={t('usernameHelp')}
            defaultValue={v('username')}
            onChange={onUsernameChange}
            error={fields?.[n('username')]}
            errorPrefix={errorPrefix}
            required
            maxLength={64}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </>
      ) : (
        <p className="max-w-[60ch] text-pretty text-base text-ink-muted">{t('localNote')}</p>
      )}
    </>
  );
}

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
  const t = useTranslations('servers.form');
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
 * How sessions from a server behave: tmux protection, startup command, environment, keepalive,
 * scrollback and auto-reopen, as three hairline-divided groups.
 */
export function ServerOptionsFields({
  prefix = '',
  initial,
  values,
  fields,
  errorPrefix,
}: FieldProps & { initial: ServerOptionsValues }) {
  const t = useTranslations('servers.form');
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
        {/* Outside the labels, so it never joins a choice's accessible name. */}
        <p className="ps-8 text-sm">
          <LearnMore section="protection" />
        </p>
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
 * The "Advanced" disclosure around the options; it opens itself when one has an error, or when
 * asked to (`defaultOpen`).
 */
export function AdvancedOptions({
  prefix = '',
  initial,
  values,
  fields,
  errorPrefix,
  defaultOpen = false,
}: FieldProps & {
  initial: ServerOptionsValues;
  /** Open from the start, e.g. when a duplicated server's options differ from the defaults. */
  defaultOpen?: boolean;
}) {
  const t = useTranslations('servers.form');
  const open = defaultOpen || ADVANCED_FIELDS.some((name) => fields?.[`${prefix}${name}`]);
  return (
    <details className="group/disclosure border-line border-t pt-4" open={open || undefined}>
      <DisclosureSummary className="font-semibold text-ink text-sm">
        {t('advanced')}
      </DisclosureSummary>
      <p className="mt-1.5 ms-5 max-w-[60ch] text-pretty text-ink-muted text-sm">
        {t('advancedHelp')}
      </p>
      <div className="mt-4 flex flex-col gap-5">
        <ServerOptionsFields
          prefix={prefix}
          initial={initial}
          values={values}
          fields={fields}
          errorPrefix={errorPrefix}
        />
      </div>
    </details>
  );
}
