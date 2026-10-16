import type { ReactNode } from 'react';
import { AlertIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';

/** Ids that tie a control to its help and error text. */
export function fieldIds(id: string, help?: ReactNode, error?: ReactNode) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;
  return { helpId, errorId, describedBy };
}

export interface FieldProps {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  /** Visually hidden prefix read before the error ("Error:"), localized by the caller. */
  errorPrefix?: string;
  /** Extra content on the label row's trailing edge. */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Label above, control, then error and help. The error replaces nothing: help stays visible. */
export function Field({
  id,
  label,
  help,
  error,
  errorPrefix,
  aside,
  className,
  children,
}: FieldProps) {
  const { helpId, errorId } = fieldIds(id, help, error);
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-semibold text-ink text-sm">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? <FieldError id={errorId} prefix={errorPrefix} message={error} /> : null}
      {help ? (
        <p id={helpId} className="text-ink-muted text-sm">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export function FieldError({
  id,
  prefix,
  message,
}: {
  id?: string;
  prefix?: string;
  message: ReactNode;
}) {
  return (
    <p id={id} className="flex items-start gap-1.5 font-medium text-danger text-sm">
      <AlertIcon size={16} className="mt-px shrink-0" />
      <span>
        {prefix ? <span className="sr-only">{prefix} </span> : null}
        {message}
      </span>
    </p>
  );
}

/** Shared look of text inputs and selects: a dark well with a light line, lit by the accent on focus. */
export const CONTROL_BASE =
  'w-full min-w-0 rounded-control border border-line-strong bg-field text-ink ' +
  'transition-[border-color,box-shadow,background-color] duration-(--duration-step) ease-(--ease-out) ' +
  'placeholder:text-ink-muted hover:border-white/50 ' +
  'focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus ' +
  'aria-invalid:border-danger aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)] ' +
  'disabled:cursor-not-allowed disabled:border-line disabled:text-ink-faint';

/** Form size: 44 px tall, 16 px text (no zoom-on-focus on phones). */
export const CONTROL_SIZE = 'h-11 px-3.5 text-md';
/** Compact size for toolbars and footers. */
export const CONTROL_SIZE_COMPACT = 'h-8 px-2.5 text-sm';

export const CONTROL_CLASSES = `${CONTROL_BASE} ${CONTROL_SIZE}`;
