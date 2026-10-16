'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { changeOwnPassword } from '../../lib/actions/auth.ts';
import type { FormState } from '../../lib/actions/form-state.ts';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';

type PasswordState = FormState & { notice?: string; savedAt?: number };

/**
 * Password change. The forced change (default action) leaves for the workspace on success;
 * /settings/account passes its own action, which stays and reports success in a notice.
 */
export function ChangePasswordForm({
  action: submit = changeOwnPassword,
  block = true,
}: {
  action?: (prev: PasswordState, formData: FormData) => Promise<PasswordState>;
  block?: boolean;
} = {}) {
  const t = useTranslations('auth.changePassword');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(submit, {} as PasswordState);
  const errorPrefix = tf('errorPrefix');
  return (
    <form action={action} noValidate className="flex flex-col gap-5" key={state.savedAt}>
      <FormMessage message={state.message} />
      {state.notice ? <Notice tone="success">{state.notice}</Notice> : null}
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
      <div>
        <SubmitButton block={block} size="lg">
          {t('submit')}
        </SubmitButton>
      </div>
    </form>
  );
}
