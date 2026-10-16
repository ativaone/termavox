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

/** Native checkbox (keyboard and forms for free) drawn in the surface's own tokens. */
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
            'peer size-5 cursor-pointer appearance-none rounded-[3px] border border-rule-strong bg-field',
            'transition-[background-color,border-color] duration-(--duration-step) ease-linear',
            'hover:border-ink-muted checked:border-primary checked:bg-primary checked:hover:bg-primary-hover',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            'aria-invalid:border-danger disabled:cursor-not-allowed disabled:border-rule disabled:bg-disabled',
          )}
          {...input}
        />
        <CheckIcon
          size={16}
          strokeWidth={2.5}
          className="pointer-events-none invisible absolute inset-0.5 text-on-primary peer-checked:visible"
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
