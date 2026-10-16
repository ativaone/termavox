'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { signIn } from '../../lib/actions/auth.ts';
import { EMPTY_FORM } from '../../lib/actions/form-state.ts';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

export function LoginForm({ notice }: { notice?: string }) {
  const t = useTranslations('auth.login');
  const [state, action] = useActionState(signIn, EMPTY_FORM);
  return (
    <form action={action} noValidate className="flex flex-col gap-5">
      {state.message ? (
        <FormMessage message={state.message} />
      ) : notice ? (
        <Notice tone="info">{notice}</Notice>
      ) : null}
      <TextField
        name="username"
        label={t('username')}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        defaultValue={state.values?.username}
      />
      <PasswordField
        name="password"
        label={t('password')}
        autoComplete="current-password"
        required
      />
      <SubmitButton block size="lg">
        {t('submit')}
      </SubmitButton>
    </form>
  );
}
