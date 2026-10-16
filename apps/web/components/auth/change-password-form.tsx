'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { changeOwnPassword } from '../../lib/actions/auth.ts';
import { EMPTY_FORM } from '../../lib/actions/form-state.ts';
import { FormMessage } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';

export function ChangePasswordForm() {
  const t = useTranslations('auth.changePassword');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(changeOwnPassword, EMPTY_FORM);
  const errorPrefix = tf('errorPrefix');
  return (
    <form action={action} noValidate className="flex flex-col gap-5">
      <FormMessage message={state.message} />
      <PasswordField
        name="currentPassword"
        label={t('current')}
        error={state.fields?.currentPassword}
        errorPrefix={errorPrefix}
        autoComplete="current-password"
        required
      />
      <PasswordField
        name="newPassword"
        label={t('new')}
        help={t('newHelp')}
        error={state.fields?.newPassword}
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
      <SubmitButton block size="lg">
        {t('submit')}
      </SubmitButton>
    </form>
  );
}
