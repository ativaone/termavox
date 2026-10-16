'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { saveInstanceSettings } from '../../lib/actions/admin.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import type { InstanceSettings } from '../../lib/repo/instance-settings.ts';
import { Checkbox } from '../ui/checkbox.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

/** Instance settings (plan §8.1 /admin/settings); every change is audited. */
export function InstanceSettingsForm({ initial }: { initial: InstanceSettings }) {
  const t = useTranslations('admin.settings');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(saveInstanceSettings, {} as ManageState);
  return (
    <form action={action} noValidate className="flex flex-col gap-6">
      <FormMessage message={state.message} />
      {state.notice ? <Notice tone="success">{state.notice}</Notice> : null}
      <section className="flex flex-col gap-3">
        <h3 className="font-semibold text-ink text-md">{t('security')}</h3>
        <Checkbox
          name="requireTotp"
          label={t('requireTotp')}
          help={t('requireTotpHelp')}
          defaultChecked={initial.requireTotp}
        />
      </section>
      <section className="flex flex-col gap-3 border-rule border-t pt-5">
        <h3 className="font-semibold text-ink text-md">{t('sessions')}</h3>
        <TextField
          name="maxRunningSessionsPerUser"
          label={t('max')}
          help={t('maxHelp')}
          defaultValue={String(initial.maxRunningSessionsPerUser)}
          error={state.fields?.maxRunningSessionsPerUser}
          errorPrefix={tf('errorPrefix')}
          inputMode="numeric"
          fieldClassName="max-w-[16rem]"
          className="tabular-nums"
        />
      </section>
      <section className="flex flex-col gap-3 border-rule border-t pt-5">
        <h3 className="font-semibold text-ink text-md">{t('direct')}</h3>
        <Checkbox
          name="localShellVisible"
          label={t('localShell')}
          help={t('localShellHelp')}
          defaultChecked={initial.localShellVisible}
        />
        <Notice tone="warning">{t('localShellWarning')}</Notice>
      </section>
      <div className="border-rule border-t pt-5">
        <SubmitButton size="lg">{t('submit')}</SubmitButton>
      </div>
    </form>
  );
}
