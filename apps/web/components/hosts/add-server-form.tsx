'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { addServer } from '../../lib/actions/add-server.ts';
import type { AddServerState, CredentialChoice } from '../../lib/actions/add-server-states.ts';
import type { HostKind } from '../../lib/repo/hosts.ts';
import { ButtonLink } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { DisclosureSummary } from '../ui/disclosure-summary.tsx';
import { CONTROL_BASE, Field, FieldError, fieldIds } from '../ui/field.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { Select } from '../ui/select.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { Tag } from '../ui/tag.tsx';
import { TextField } from '../ui/text-field.tsx';
import { AddServerDone } from './add-server-result.tsx';
import { AddServerSection, ChoiceCard } from './add-server-section.tsx';
import { PROFILE_DEFAULTS, ProfileOptionsFields } from './profile-form.tsx';

export interface AddServerHostOption {
  id: string;
  name: string;
  kind: HostKind;
  /** `hostname:port`, or null for a local shell. */
  address: string | null;
}

export interface AddServerCredentialOption {
  id: string;
  name: string;
}

interface AddServerProps {
  hosts: AddServerHostOption[];
  credentials: AddServerCredentialOption[];
  /** The local (direct-mode) kind is offered only when allowed (admin + instance setting). */
  localAllowed: boolean;
  /** Where Cancel and, after success, "Back to …" lead (the page the user came from). */
  back: { href: string; label: string };
}

const NEW_CHOICES: readonly CredentialChoice[] = ['generate', 'private_key', 'password'];
/** Profile inputs that live in the "Advanced" disclosure (opened when one of them has an error). */
const ADVANCED = [
  'protectionMode',
  'startupCommand',
  'env',
  'keepaliveIntervalS',
  'scrollbackLines',
];
/** Inputs whose value is never echoed back: they must be typed again after a failed submit. */
const SECRET_CHOICES: readonly CredentialChoice[] = ['private_key', 'password'];

/**
 * "Add server" (plan D-27): one form in three numbered sections (server, sign-in, credential)
 * that creates whatever is missing at once, then shows the result in place.
 */
export function AddServerForm(props: AddServerProps) {
  const [state, action] = useActionState(addServer, {} as AddServerState);
  if (state.created) return <AddServerDone created={state.created} back={props.back} />;
  return <AddServerFields {...props} state={state} action={action} />;
}

function AddServerFields({
  hosts,
  credentials,
  localAllowed,
  back,
  state,
  action,
}: AddServerProps & { state: AddServerState; action: (formData: FormData) => void }) {
  const t = useTranslations('hosts.addServer');
  const th = useTranslations('hosts.form');
  const tc = useTranslations('credentials.create');
  const tf = useTranslations('common.field');
  const errorPrefix = tf('errorPrefix');
  const values = state.values ?? {};
  const fields = state.fields ?? {};
  const v = (name: string, fallback = '') => values[name] ?? fallback;

  const [hostMode, setHostMode] = useState<'new' | 'existing'>('new');
  const [hostKind, setHostKind] = useState<HostKind>('ssh');
  const [hostId, setHostId] = useState(hosts[0]?.id ?? '');
  const [choice, setChoice] = useState<CredentialChoice>('generate');
  const [username, setUsername] = useState('');
  const [serverName, setServerName] = useState('');

  const existingHost = hosts.find((host) => host.id === hostId) ?? null;
  const kind: HostKind = hostMode === 'existing' ? (existingHost?.kind ?? 'ssh') : hostKind;
  const nameForExample = hostMode === 'existing' ? (existingHost?.name ?? '') : serverName;
  const example = `${username.trim() || t('credential.exampleUser')}@${
    nameForExample.trim() || t('credential.exampleServer')
  }`;
  const advancedError = ADVANCED.some((name) => fields[`profile.${name}`]);
  const errorCount = Object.keys(fields).length;
  const secretLost = errorCount > 0 || Boolean(state.message);

  // After a refused submit, take the keyboard to the first field that needs attention.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.fields || Object.keys(state.fields).length === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const privateKeyId = 'add-server-private-key';
  const keyIds = fieldIds(privateKeyId, tc('privateKeyHelp'), fields['credential.privateKey']);
  const optional = (label: string) => (
    <>
      {label} <span className="font-normal text-ink-muted">{t('optional')}</span>
    </>
  );

  return (
    <form
      ref={formRef}
      action={action}
      noValidate
      autoComplete="off"
      className="flex flex-col gap-6"
    >
      {/* ── 1. server ─────────────────────────────────────────────────────── */}
      <AddServerSection
        id="add-server-server"
        step={1}
        title={t('server.title')}
        intro={t('server.intro')}
      >
        {hosts.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('server.choice')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <ChoiceCard
                name="host.mode"
                value="new"
                checked={hostMode === 'new'}
                onChange={() => setHostMode('new')}
                title={t('server.new')}
                help={t('server.newHelp')}
              />
              <ChoiceCard
                name="host.mode"
                value="existing"
                checked={hostMode === 'existing'}
                onChange={() => setHostMode('existing')}
                title={t('server.existing')}
                help={t('server.existingHelp')}
              />
            </div>
          </fieldset>
        ) : (
          <input type="hidden" name="host.mode" value="new" />
        )}

        {hostMode === 'existing' ? (
          <Select
            name="host.id"
            label={t('server.pick')}
            help={t('server.pickHelp')}
            value={hostId}
            onChange={(event) => setHostId(event.target.value)}
            error={fields['host.id']}
            errorPrefix={errorPrefix}
            options={hosts.map((host) => ({
              value: host.id,
              label: host.address ? `${host.name} (${host.address})` : host.name,
            }))}
          />
        ) : (
          <>
            <TextField
              name="host.name"
              label={th('name')}
              help={th('nameHelp')}
              defaultValue={v('host.name')}
              onChange={(event) => setServerName(event.target.value)}
              error={fields['host.name']}
              errorPrefix={errorPrefix}
              required
              maxLength={80}
            />
            {localAllowed ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1.5 font-semibold text-ink text-sm">{th('kind')}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ChoiceCard
                    name="host.kind"
                    value="ssh"
                    checked={hostKind === 'ssh'}
                    onChange={() => setHostKind('ssh')}
                    title={th('kindSsh')}
                    help={th('kindSshHelp')}
                  />
                  <ChoiceCard
                    name="host.kind"
                    value="local"
                    checked={hostKind === 'local'}
                    onChange={() => setHostKind('local')}
                    title={th('kindLocal')}
                    help={th('kindLocalHelp')}
                  />
                </div>
                {fields['host.kind'] ? (
                  <FieldError prefix={errorPrefix} message={fields['host.kind']} />
                ) : null}
              </fieldset>
            ) : (
              <input type="hidden" name="host.kind" value="ssh" />
            )}
            {hostKind === 'ssh' ? (
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <TextField
                  name="host.hostname"
                  label={th('hostname')}
                  help={th('hostnameHelp')}
                  defaultValue={v('host.hostname')}
                  error={fields['host.hostname']}
                  errorPrefix={errorPrefix}
                  required
                  maxLength={253}
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <TextField
                  name="host.port"
                  label={th('port')}
                  defaultValue={v('host.port', '22')}
                  error={fields['host.port']}
                  errorPrefix={errorPrefix}
                  inputMode="numeric"
                  required
                  className="tabular-nums"
                />
              </div>
            ) : null}
          </>
        )}
      </AddServerSection>

      {/* ── 2. sign-in: always a new connection profile ───────────────────── */}
      <AddServerSection
        id="add-server-sign-in"
        step={2}
        title={t('signIn.title')}
        intro={t('signIn.intro')}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            name="profile.username"
            label={t('signIn.username')}
            help={t('signIn.usernameHelp')}
            defaultValue={v('profile.username')}
            onChange={(event) => setUsername(event.target.value)}
            error={fields['profile.username']}
            errorPrefix={errorPrefix}
            required
            maxLength={64}
            autoCapitalize="none"
            spellCheck={false}
          />
          <TextField
            name="profile.name"
            label={optional(t('signIn.name'))}
            help={t('signIn.nameHelp')}
            placeholder={username.trim() || undefined}
            defaultValue={v('profile.name')}
            error={fields['profile.name']}
            errorPrefix={errorPrefix}
            maxLength={80}
          />
        </div>
        <details
          className="group/disclosure border-line border-t pt-4"
          open={advancedError || undefined}
        >
          <DisclosureSummary className="font-semibold text-ink text-sm">
            {t('signIn.advanced')}
          </DisclosureSummary>
          <p className="mt-1.5 ms-5 max-w-[60ch] text-pretty text-ink-muted text-sm">
            {t('signIn.advancedHelp')}
          </p>
          <div className="mt-4 flex flex-col gap-5">
            <ProfileOptionsFields
              prefix="profile."
              initial={PROFILE_DEFAULTS}
              values={values}
              fields={fields}
              errorPrefix={errorPrefix}
            />
          </div>
        </details>
      </AddServerSection>

      {/* ── 3. credential ─────────────────────────────────────────────────── */}
      <AddServerSection
        id="add-server-credential"
        step={3}
        title={t('credential.title')}
        intro={kind === 'ssh' ? t('credential.intro') : t('credential.local')}
      >
        {kind === 'ssh' ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 font-semibold text-ink text-sm">
                {t('credential.choice')}
              </legend>
              {/* One column: three or four choices never leave a hole in a grid. */}
              <div className="flex flex-col gap-2">
                {[...NEW_CHOICES, ...(credentials.length > 0 ? (['saved'] as const) : [])].map(
                  (value) => (
                    <ChoiceCard
                      key={value}
                      name="credential.mode"
                      value={value}
                      checked={choice === value}
                      onChange={() => setChoice(value)}
                      title={t(`credential.choices.${value}`)}
                      help={t(`credential.choiceHelp.${value}`)}
                      tag={
                        value === 'generate' ? <Tag>{t('credential.recommended')}</Tag> : undefined
                      }
                    />
                  ),
                )}
              </div>
            </fieldset>

            {choice === 'generate' ? (
              <p className="max-w-[60ch] text-pretty text-base text-ink-muted">
                {t('credential.generateNote')}
              </p>
            ) : null}
            {choice === 'private_key' ? (
              <>
                <Field
                  id={privateKeyId}
                  label={tc('privateKey')}
                  help={tc('privateKeyHelp')}
                  error={fields['credential.privateKey']}
                  errorPrefix={errorPrefix}
                >
                  <textarea
                    id={privateKeyId}
                    name="credential.privateKey"
                    rows={7}
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-invalid={fields['credential.privateKey'] ? true : undefined}
                    aria-describedby={keyIds.describedBy}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    className={cx(CONTROL_BASE, 'resize-y px-3 py-2.5 font-mono text-sm leading-5')}
                  />
                </Field>
                <PasswordField
                  name="credential.passphrase"
                  label={optional(tc('passphrase'))}
                  help={tc('passphraseHelp')}
                  autoComplete="off"
                />
              </>
            ) : null}
            {choice === 'password' ? (
              <PasswordField
                name="credential.password"
                label={tc('password')}
                help={tc('passwordHelp')}
                error={fields['credential.password']}
                errorPrefix={errorPrefix}
                autoComplete="new-password"
                required
              />
            ) : null}
            {SECRET_CHOICES.includes(choice) && secretLost ? (
              <p className="text-ink-muted text-sm">{t('credential.reenter')}</p>
            ) : null}
            {choice === 'saved' ? (
              <Select
                name="credential.id"
                label={t('credential.pick')}
                defaultValue={v('credential.id', credentials[0]?.id ?? '')}
                error={fields['credential.id']}
                errorPrefix={errorPrefix}
                options={credentials.map((c) => ({ value: c.id, label: c.name }))}
              />
            ) : (
              <TextField
                name="credential.name"
                label={optional(t('credential.name'))}
                help={t('credential.nameHelp', { example })}
                placeholder={example}
                defaultValue={v('credential.name')}
                error={fields['credential.name']}
                errorPrefix={errorPrefix}
                maxLength={120}
              />
            )}
          </>
        ) : null}
      </AddServerSection>

      <div className="flex flex-col gap-4">
        {errorCount > 0 ? (
          <Notice tone="danger">{t('fixFields', { count: errorCount })}</Notice>
        ) : null}
        <FormMessage message={state.message} />
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="lg">{t('submit')}</SubmitButton>
          <ButtonLink href={back.href} variant="quiet" size="lg">
            {t('cancel')}
          </ButtonLink>
        </div>
        {/* Lives with the form (not the page intro), so it leaves with it on success. */}
        {errorCount === 0 && !state.message ? (
          <p className="text-ink-muted text-sm">{t('nothingSaved')}</p>
        ) : null}
      </div>
    </form>
  );
}
