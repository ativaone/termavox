'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';
import { enrollTotp } from '../../lib/actions/auth.ts';
import type { EnrollState } from '../../lib/actions/form-state.ts';
import { ArrowRightIcon } from '../icons/index.tsx';
import { buttonClasses } from '../ui/button.tsx';
import { CopyButton } from '../ui/copy-button.tsx';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';
import { QrCode } from './qr-code.tsx';

const START: EnrollState = { step: 'password' };

/** Splits a base32 secret in fours so it can be read off the screen and typed. */
function secretGroups(secret: string): string[] {
  return secret.match(/.{1,4}/g) ?? [];
}

/**
 * Forced TOTP enrollment in three steps on one sheet: confirm the password (creates the secret),
 * scan or type the key and prove it with a code, then keep the backup codes shown only once.
 */
export function EnrollTotp({
  enrolled,
  workspaceHref,
  continueLabel,
}: {
  enrolled: boolean;
  workspaceHref: string;
  /** Label of the final link (default: continue to the workspace). */
  continueLabel?: string;
}) {
  const t = useTranslations('auth.enrollTotp');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(enrollTotp, START);
  const errorPrefix = tf('errorPrefix');
  const codesId = useId();
  const scanId = useId();

  if (state.step === 'done') {
    return (
      <div className="flex flex-col gap-5">
        <Notice tone="success" title={t('doneTitle')}>
          {t('doneIntro')}
        </Notice>
        <section aria-labelledby={codesId} className="flex flex-col gap-3">
          <h2 id={codesId} className="font-semibold text-ink text-sm">
            {t('doneCodesLabel')}
          </h2>
          <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-control bg-field px-4 py-3 font-mono text-base text-ink tabular-nums">
            {state.backupCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ol>
          <CopyButton value={state.backupCodes.join('\n')} label={t('doneCopy')} />
        </section>
        <Link
          href={workspaceHref}
          className={buttonClasses({ variant: 'primary', size: 'lg', block: true })}
        >
          {continueLabel ?? t('doneContinue')}
          <ArrowRightIcon size={18} />
        </Link>
      </div>
    );
  }

  if (state.step === 'verify') {
    return (
      <form action={action} noValidate className="flex flex-col gap-5">
        <input type="hidden" name="intent" value="verify" />
        <FormMessage message={state.message} />
        <section aria-labelledby={scanId} className="flex flex-col gap-3">
          <h2 id={scanId} className="font-semibold text-ink text-md">
            {t('scanTitle')}
          </h2>
          <p className="text-base text-ink-muted">{t('scanHelp')}</p>
          <QrCode qr={state.qr} label={t('qrLabel')} />
          <div className="flex flex-col gap-2">
            <p className="text-ink-muted text-sm">{t('manualLabel')}</p>
            <p className="flex flex-wrap gap-x-2.5 gap-y-1 rounded-control bg-field px-3 py-2 font-mono text-base text-ink">
              {secretGroups(state.secret).map((group, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: groups of a fixed string, never reordered
                <span key={index}>{group}</span>
              ))}
            </p>
            <CopyButton value={state.secret} label={t('manualCopy')} />
          </div>
        </section>
        <TextField
          name="code"
          label={t('code')}
          help={t('codeHelp')}
          error={state.fields?.code}
          errorPrefix={errorPrefix}
          mono
          required
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={7}
          spellCheck={false}
          fieldClassName="border-rule border-t pt-5"
        />
        <SubmitButton block size="lg">
          {t('verify')}
        </SubmitButton>
      </form>
    );
  }

  if (enrolled) {
    return (
      <div className="flex flex-col gap-5">
        <Notice tone="success" title={t('enrolledTitle')}>
          {t('enrolledIntro')}
        </Notice>
        <Link
          href={workspaceHref}
          className={buttonClasses({ variant: 'primary', size: 'lg', block: true })}
        >
          {t('doneContinue')}
          <ArrowRightIcon size={18} />
        </Link>
      </div>
    );
  }

  return (
    <form action={action} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="intent" value="start" />
      <FormMessage message={state.message} />
      <PasswordField
        name="password"
        label={t('password')}
        help={t('passwordHelp')}
        error={state.fields?.password}
        errorPrefix={errorPrefix}
        autoComplete="current-password"
        required
      />
      <SubmitButton block size="lg">
        {t('start')}
      </SubmitButton>
    </form>
  );
}
