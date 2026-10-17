import { type InputHTMLAttributes, type ReactNode, type Ref, useId } from 'react';
import { cx } from './cx.ts';
import { CONTROL_CLASSES, Field, fieldIds } from './field.tsx';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  errorPrefix?: string;
  /** Monospace value (codes, keys). */
  mono?: boolean;
  fieldClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

export function TextField({
  id: idProp,
  label,
  help,
  error,
  errorPrefix,
  mono = false,
  className,
  fieldClassName,
  type = 'text',
  ref,
  ...input
}: TextFieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
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
      <input
        ref={ref}
        id={id}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(CONTROL_CLASSES, mono && 'font-mono tracking-wide', className)}
        {...input}
      />
    </Field>
  );
}
