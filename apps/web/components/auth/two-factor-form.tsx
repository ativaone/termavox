'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { verifyTwoFactor } from '../../lib/actions/auth.ts';
import { EMPTY_FORM } from '../../lib/actions/form-state.ts';
import { Button } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { FormMessage } from '../ui/notice.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

/** Second sign-in step: a TOTP code, or a single-use backup code as the way back in. */
export function TwoFactorForm() {
  const t = useTranslations('auth.twoFactor');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(verifyTwoFactor, EMPTY_FORM);
  const [mode, setMode] = useState<'totp' | 'backup'>(
    state.values?.mode === 'backup' ? 'backup' : 'totp',
  );
  const backup = mode === 'backup';
  return (
    <form action={action} noValidate className="flex flex-col gap-5">
      <FormMessage message={state.message} />
      <input type="hidden" name="mode" value={mode} />
      {backup ? <p className="text-base text-ink-muted">{t('backupIntro')}</p> : null}
      <TextField
        key={mode}
        name="code"
        label={backup ? t('backupCode') : t('code')}
        help={backup ? undefined : t('codeHelp')}
        error={state.fields?.code}
        errorPrefix={tf('errorPrefix')}
        mono
        required
        autoComplete={backup ? 'off' : 'one-time-code'}
        inputMode={backup ? 'text' : 'numeric'}
        maxLength={backup ? 32 : 7}
        autoCapitalize="none"
        spellCheck={false}
      />
      <Checkbox
        name="trustDevice"
        label={t('trustDevice')}
        help={t('trustDeviceHelp')}
        defaultChecked={state.values?.trustDevice === 'on'}
      />
      <SubmitButton block size="lg">
        {t('submit')}
      </SubmitButton>
      <Button
        variant="quiet"
        size="sm"
        className="-ms-2.5 self-start"
        onClick={() => setMode(backup ? 'totp' : 'backup')}
      >
        {backup ? t('useTotp') : t('useBackup')}
      </Button>
    </form>
  );
}
