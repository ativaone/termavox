'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { addServer } from '../../lib/actions/add-server.ts';
import type { AddServerState, CredentialChoice } from '../../lib/actions/add-server-states.ts';
import type { ServerKind } from '../../lib/repo/servers.ts';
import { optionsDifferFromDefaults, SERVER_OPTION_DEFAULTS } from '../../lib/servers/options.ts';
import { ButtonLink } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { CONTROL_BASE, Field, fieldIds } from '../ui/field.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { Select } from '../ui/select.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { Tag } from '../ui/tag.tsx';
import { TextField } from '../ui/text-field.tsx';
import { AddServerDone } from './add-server-result.tsx';
import { AddServerSection, ChoiceCard } from './add-server-section.tsx';
import { AdvancedOptions, ServerTargetFields } from './server-fields.tsx';

export interface AddServerCredentialOption {
  id: string;
  name: string;
}

interface AddServerProps {
  credentials: AddServerCredentialOption[];
  /** The local (direct-mode) kind is offered only when allowed (admin + instance setting). */
  localAllowed: boolean;
  /** Where Cancel and, after success, "Back to …" lead (the page the user came from). */
  back: { href: string; label: string };
  /** Starting values (the prefixed field names), e.g. a duplicated server's. */
  initialValues?: Record<string, string>;
}

/** Inputs whose value is never echoed back: they must be typed again after a failed submit. */
const SECRET_CHOICES: readonly CredentialChoice[] = ['private_key', 'password'];

/**
 * "Add server" (plan D-29): one form in two numbered sections, the server (where it is, the user
 * name, and the session options behind "Advanced") and its credential, then the result in place.
 */
export function AddServerForm(props: AddServerProps) {
  const [state, action] = useActionState(addServer, {} as AddServerState);
  if (state.created) return <AddServerDone created={state.created} back={props.back} />;
  return <AddServerFields {...props} state={state} action={action} />;
}

function AddServerFields({
  credentials,
  localAllowed,
  back,
  initialValues,
  state,
  action,
}: AddServerProps & { state: AddServerState; action: (formData: FormData) => void }) {
  const t = useTranslations('servers.addServer');
  const tc = useTranslations('credentials.create');
  const tf = useTranslations('common.field');
  const errorPrefix = tf('errorPrefix');
  const values = state.values ?? initialValues ?? {};
  const fields = state.fields ?? {};
  const v = (name: string, fallback = '') => values[name] ?? fallback;

  const choices: CredentialChoice[] = [
    'generate',
    'private_key',
    'password',
    ...(credentials.length > 0 ? (['saved'] as const) : []),
    'none',
  ];
  const [kind, setKind] = useState<ServerKind>(() =>
    localAllowed && values['server.kind'] === 'local' ? 'local' : 'ssh',
  );
  const [choice, setChoice] = useState<CredentialChoice>(() => {
    const initial = values['credential.mode'] as CredentialChoice | undefined;
    return initial && choices.includes(initial) ? initial : 'generate';
  });
  const [username, setUsername] = useState(() => v('server.username'));
  const [serverName, setServerName] = useState(() => v('server.name'));

  const example = `${username.trim() || t('credential.exampleUser')}@${
    serverName.trim() || t('credential.exampleServer')
  }`;
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
  const savedDefault = credentials.some((c) => c.id === values['credential.id'])
    ? (values['credential.id'] as string)
    : (credentials[0]?.id ?? '');

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
        <ServerTargetFields
          prefix="server."
          values={values}
          fields={fields}
          errorPrefix={errorPrefix}
          kind={kind}
          onKindChange={setKind}
          localAllowed={localAllowed}
          onNameChange={(event) => setServerName(event.target.value)}
          onUsernameChange={(event) => setUsername(event.target.value)}
        />
        <AdvancedOptions
          prefix="server."
          initial={SERVER_OPTION_DEFAULTS}
          values={values}
          fields={fields}
          errorPrefix={errorPrefix}
          defaultOpen={optionsDifferFromDefaults(values, 'server.')}
        />
      </AddServerSection>

      {/* ── 2. credential (a local shell needs none) ──────────────────────── */}
      {kind === 'ssh' ? (
        <AddServerSection
          id="add-server-credential"
          step={2}
          title={t('credential.title')}
          intro={t('credential.intro')}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 font-semibold text-ink text-sm">
              {t('credential.choice')}
            </legend>
            {/* One column: four or five choices never leave a hole in a grid. */}
            <div className="flex flex-col gap-2">
              {choices.map((value) => (
                <ChoiceCard
                  key={value}
                  name="credential.mode"
                  value={value}
                  checked={choice === value}
                  onChange={() => setChoice(value)}
                  title={t(`credential.choices.${value}`)}
                  help={t(`credential.choiceHelp.${value}`)}
                  tag={value === 'generate' ? <Tag>{t('credential.recommended')}</Tag> : undefined}
                />
              ))}
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
              defaultValue={savedDefault}
              error={fields['credential.id']}
              errorPrefix={errorPrefix}
              options={credentials.map((c) => ({ value: c.id, label: c.name }))}
            />
          ) : null}
          {choice === 'none' ? (
            <p className="max-w-[60ch] text-pretty text-base text-ink-muted">
              {t('credential.noneNote')}
            </p>
          ) : null}
          {choice === 'generate' || choice === 'private_key' || choice === 'password' ? (
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
          ) : null}
        </AddServerSection>
      ) : null}

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
