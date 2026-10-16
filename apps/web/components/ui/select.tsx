import { type ReactNode, type SelectHTMLAttributes, useId } from 'react';
import { ChevronDownIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';
import { CONTROL_BASE, CONTROL_SIZE, CONTROL_SIZE_COMPACT, Field, fieldIds } from './field.tsx';

export interface SelectOption {
  value: string;
  label: string;
}

interface NativeSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: readonly SelectOption[];
  /** Compact height for toolbars and footers. */
  compact?: boolean;
}

/** The native select (keyboard, mobile pickers and screen readers for free), restyled. */
export function NativeSelect({ options, compact = false, className, ...props }: NativeSelectProps) {
  return (
    <span className="relative inline-flex w-full">
      <select
        className={cx(
          CONTROL_BASE,
          compact ? CONTROL_SIZE_COMPACT : CONTROL_SIZE,
          'cursor-pointer appearance-none pe-9',
          className,
        )}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon
        size={16}
        className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
      />
    </span>
  );
}

export interface SelectProps extends NativeSelectProps {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  errorPrefix?: string;
}

export function Select({ id: idProp, label, help, error, errorPrefix, ...props }: SelectProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const { describedBy } = fieldIds(id, help, error);
  return (
    <Field id={id} label={label} help={help} error={error} errorPrefix={errorPrefix}>
      <NativeSelect
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...props}
      />
    </Field>
  );
}
