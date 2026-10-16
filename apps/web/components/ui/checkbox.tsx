import { type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { CheckIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';
import { FieldError, fieldIds } from './field.tsx';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  errorPrefix?: string;
}

/** Native checkbox (keyboard and forms for free) drawn in the world's tokens: a well that fills with the accent. */
export function Checkbox({
  id: idProp,
  label,
  help,
  error,
  errorPrefix,
  className,
  ...input
}: CheckboxProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const { helpId, errorId, describedBy } = fieldIds(id, help, error);
  return (
    <div className={cx('flex gap-3', className)}>
      <span className="relative mt-0.5 inline-flex size-5 shrink-0">
        <input
          id={id}
          type="checkbox"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(
            'peer size-5 cursor-pointer appearance-none rounded-xs border border-line-strong bg-field',
            'transition-[background-color,border-color] duration-(--duration-step) ease-(--ease-out)',
            'hover:border-white/50 checked:border-accent checked:bg-accent',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            'aria-invalid:border-danger disabled:cursor-not-allowed disabled:border-line disabled:bg-surface',
          )}
          {...input}
        />
        <CheckIcon
          size={16}
          strokeWidth={2.5}
          className="pointer-events-none invisible absolute inset-0.5 text-on-accent peer-checked:visible"
        />
      </span>
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="cursor-pointer font-medium text-base text-ink">
          {label}
        </label>
        {error ? <FieldError id={errorId} prefix={errorPrefix} message={error} /> : null}
        {help ? (
          <p id={helpId} className="text-ink-muted text-sm">
            {help}
          </p>
        ) : null}
      </div>
    </div>
  );
}
