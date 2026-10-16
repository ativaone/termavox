'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { disableTotp } from '../../lib/actions/settings.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import { FormMessage } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';

/** Turns two-step verification off once the password is confirmed. */
export function DisableTotp() {
  const t = useTranslations('settings.account.totp');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(disableTotp, {} as ManageState);
  return (
    <form action={action} noValidate className="flex max-w-[26rem] flex-col gap-4">
      <FormMessage message={state.message} />
      <PasswordField
        name="password"
        label={t('password')}
        help={t('disableHelp')}
        error={state.fields?.password}
        errorPrefix={tf('errorPrefix')}
        autoComplete="current-password"
        required
      />
      <div>
        <SubmitButton variant="destructive" isolated={false}>
          {t('disable')}
        </SubmitButton>
      </div>
    </form>
  );
}
