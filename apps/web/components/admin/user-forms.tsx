'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import {
  createUser,
  resetUserPassword,
  setUserBanned,
  setUserRole,
} from '../../lib/actions/admin.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import { buttonClasses } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { cx } from '../ui/cx.ts';
import { DANGER_SLIP_CLASSES, FormMessage, Notice } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { Select } from '../ui/select.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

function Result({ state }: { state: ManageState }) {
  return (
    <>
      {state.notice ? <Notice tone="success">{state.notice}</Notice> : null}
      <FormMessage message={state.message} tone={state.notice ? 'warning' : 'danger'} />
    </>
  );
}

/** Admin creates an account with a temporary password (changed at first sign-in). */
export function CreateUserForm() {
  const t = useTranslations('admin.users.create');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(createUser, {} as ManageState);
  const v = state.values ?? {};
  const errorPrefix = tf('errorPrefix');
  return (
    <form action={action} noValidate className="flex flex-col gap-5" autoComplete="off">
      <FormMessage message={state.message} />
      <TextField
        name="username"
        label={t('username')}
        help={t('usernameHelp')}
        defaultValue={v.username ?? ''}
        error={state.fields?.username}
        errorPrefix={errorPrefix}
        required
        autoCapitalize="none"
        spellCheck={false}
        maxLength={30}
      />
      <TextField
        name="email"
        type="email"
        label={t('email')}
        defaultValue={v.email ?? ''}
        error={state.fields?.email}
        errorPrefix={errorPrefix}
        required
        autoCapitalize="none"
        spellCheck={false}
      />
      <TextField
        name="name"
        label={t('name')}
        help={t('nameHelp')}
        defaultValue={v.name ?? ''}
        error={state.fields?.name}
        errorPrefix={errorPrefix}
        maxLength={100}
      />
      <PasswordField
        name="temporaryPassword"
        label={t('password')}
        help={t('passwordHelp')}
        error={state.fields?.temporaryPassword}
        errorPrefix={errorPrefix}
        autoComplete="new-password"
        required
      />
      <Select
        name="role"
        label={t('role')}
        defaultValue={v.role ?? 'user'}
        options={[
          { value: 'user', label: t('roles.user') },
          { value: 'admin', label: t('roles.admin') },
        ]}
      />
      <Checkbox
        name="totpRequired"
        label={t('totp')}
        help={t('totpHelp')}
        defaultChecked={v.totpRequired === 'on'}
      />
      <div>
        <SubmitButton size="lg">{t('submit')}</SubmitButton>
      </div>
    </form>
  );
}

/**
 * Disable (with the option to terminate running sessions) or re-enable an account. One action
 * state for both, so the outcome (sessions terminated, connections that could not be closed)
 * stays on screen after the page re-renders with the new status.
 */
export function BanControl({
  userId,
  username,
  banned,
  liveSessions,
}: {
  userId: string;
  username: string;
  banned: boolean;
  liveSessions: number;
}) {
  const t = useTranslations('admin.users.ban');
  const [state, action] = useActionState(setUserBanned, {} as ManageState);
  return (
    <div className="flex flex-col items-start gap-3">
      <Result state={state} />
      {banned ? (
        <form action={action} className="flex flex-col items-start gap-3">
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="banned" value="0" />
          <p className="max-w-[60ch] text-pretty text-base text-ink-muted">{t('enableIntro')}</p>
          <SubmitButton>{t('enable')}</SubmitButton>
        </form>
      ) : (
        <>
          <p className="max-w-[60ch] text-pretty text-base text-ink-muted">{t('disableIntro')}</p>
          <details className="group">
            <summary
              className={cx(
                buttonClasses({ variant: 'destructive', size: 'sm', isolated: false }),
                'cursor-pointer list-none [&::-webkit-details-marker]:hidden',
              )}
            >
              {t('disable')}
            </summary>
            <form action={action} className={cx(DANGER_SLIP_CLASSES, 'mt-3 max-w-[34rem]')}>
              <input type="hidden" name="userId" value={userId} />
              <input type="hidden" name="banned" value="1" />
              <p className="text-pretty">{t('question', { username })}</p>
              <Checkbox
                name="terminateSessions"
                label={t('terminate', { count: liveSessions })}
                help={t('terminateHelp')}
                disabled={liveSessions === 0}
              />
              <div>
                <SubmitButton variant="destructive" size="sm" isolated={false}>
                  {t('confirm')}
                </SubmitButton>
              </div>
            </form>
          </details>
        </>
      )}
    </div>
  );
}

/** Temporary password: forced change at next sign-in, the user's browsers signed out. */
export function ResetPasswordForm({ userId }: { userId: string }) {
  const t = useTranslations('admin.users.password');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(resetUserPassword, {} as ManageState);
  return (
    <form
      action={action}
      noValidate
      className="flex max-w-[26rem] flex-col gap-4"
      key={state.savedAt}
    >
      <input type="hidden" name="userId" value={userId} />
      <Result state={state} />
      <PasswordField
        name="temporaryPassword"
        label={t('label')}
        help={t('help')}
        error={state.fields?.temporaryPassword}
        errorPrefix={tf('errorPrefix')}
        autoComplete="new-password"
      />
      <div>
        <SubmitButton variant="secondary">{t('submit')}</SubmitButton>
      </div>
    </form>
  );
}

export function RoleForm({
  userId,
  role,
  disabled,
}: {
  userId: string;
  role: 'admin' | 'user';
  disabled: boolean;
}) {
  const t = useTranslations('admin.users.role');
  const [state, action] = useActionState(setUserRole, {} as ManageState);
  return (
    <form action={action} className="flex max-w-[26rem] flex-col gap-4">
      <input type="hidden" name="userId" value={userId} />
      <Result state={state} />
      <Select
        name="role"
        label={t('label')}
        help={disabled ? t('selfHelp') : t('help')}
        defaultValue={role}
        disabled={disabled}
        options={[
          { value: 'user', label: t('user') },
          { value: 'admin', label: t('admin') },
        ]}
      />
      <div>
        <SubmitButton variant="secondary" disabled={disabled}>
          {t('submit')}
        </SubmitButton>
      </div>
    </form>
  );
}
