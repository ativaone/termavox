'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { renameCredential } from '../../lib/actions/credentials.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import { ButtonLink } from '../ui/button.tsx';
import { FormMessage } from '../ui/notice.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

/** Inline rename (the only mutable field of a credential). */
export function RenameCredential({ id, name }: { id: string; name: string }) {
  const t = useTranslations('credentials.rename');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(renameCredential, {} as ManageState);
  return (
    <form action={action} noValidate className="flex w-full flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <FormMessage message={state.message} />
      <TextField
        name="name"
        label={t('label')}
        defaultValue={state.values?.name ?? name}
        error={state.fields?.name}
        errorPrefix={tf('errorPrefix')}
        maxLength={120}
        required
        autoFocus
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton size="sm">{t('submit')}</SubmitButton>
        <ButtonLink href="/credentials" variant="quiet" size="sm" scroll={false}>
          {t('cancel')}
        </ButtonLink>
      </div>
    </form>
  );
}
