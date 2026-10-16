'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { setUp } from '../../lib/actions/auth.ts';
import { EMPTY_FORM } from '../../lib/actions/form-state.ts';
import { FormMessage } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

/** First-run setup: the one-time token, then the first administrator. */
export function SetupForm() {
  const t = useTranslations('auth.setup');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(setUp, EMPTY_FORM);
  const errorPrefix = tf('errorPrefix');
  return (
    <form action={action} noValidate className="flex flex-col gap-6">
      <FormMessage message={state.message} />
      {/* A password input: the token never shows on screen or in a screenshot. */}
      <PasswordField
        name="token"
        label={t('token')}
        help={t('tokenHelp')}
        error={state.fields?.token}
        errorPrefix={errorPrefix}
        autoComplete="off"
        required
        className="font-mono"
      />
      <fieldset className="flex flex-col gap-5 border-line border-t pt-5">
        <legend className="float-left mb-1 w-full font-semibold text-ink text-md">
          {t('admin')}
        </legend>
        <TextField
          name="username"
          label={t('username')}
          help={t('usernameHelp')}
          error={state.fields?.username}
          errorPrefix={errorPrefix}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          minLength={3}
          maxLength={30}
          defaultValue={state.values?.username}
        />
        <TextField
          name="email"
          type="email"
          label={t('email')}
          error={state.fields?.email}
          errorPrefix={errorPrefix}
          autoComplete="email"
          required
          defaultValue={state.values?.email}
        />
        <PasswordField
          name="password"
          label={t('password')}
          help={t('passwordHelp')}
          error={state.fields?.password}
          errorPrefix={errorPrefix}
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
        />
        <PasswordField
          name="confirm"
          label={t('confirm')}
          error={state.fields?.confirm}
          errorPrefix={errorPrefix}
          autoComplete="new-password"
          required
        />
      </fieldset>
      <SubmitButton block size="lg">
        {t('submit')}
      </SubmitButton>
    </form>
  );
}
