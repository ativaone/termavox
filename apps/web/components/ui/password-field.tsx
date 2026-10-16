'use client';

import { useTranslations } from 'next-intl';
import { type InputHTMLAttributes, type ReactNode, useId, useState } from 'react';
import { EyeIcon, EyeOffIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';
import { CONTROL_CLASSES, Field, fieldIds } from './field.tsx';

export interface PasswordFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  errorPrefix?: string;
  fieldClassName?: string;
}

/** Password input with a reveal toggle (a real button, announced as pressed or not). */
export function PasswordField({
  id: idProp,
  label,
  help,
  error,
  errorPrefix,
  className,
  fieldClassName,
  ...input
}: PasswordFieldProps) {
  const t = useTranslations('common.password');
  const autoId = useId();
  const id = idProp ?? autoId;
  const [visible, setVisible] = useState(false);
  const { describedBy } = fieldIds(id, help, error);
  return (
    <Field
      id={id}
      label={label}
      help={help}
      error={error}
      errorPrefix={errorPrefix}
      className={fieldClassName}
    >
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          spellCheck={false}
          autoCapitalize="none"
          className={cx(CONTROL_CLASSES, 'pe-12', className)}
          {...input}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? t('hide') : t('show')}
          aria-controls={id}
          disabled={input.disabled}
          className={cx(
            'absolute inset-y-1 end-1 inline-flex w-10 items-center justify-center rounded-[3px] text-ink-muted',
            'transition-colors duration-(--duration-step) ease-linear hover:bg-quiet-hover hover:text-ink',
            'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
            'disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent',
          )}
        >
          {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
        </button>
      </div>
    </Field>
  );
}
