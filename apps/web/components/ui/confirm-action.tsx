'use client';

import { type ReactNode, useActionState, useId } from 'react';
import type { ManageState } from '../../lib/manage/forms.ts';
import { buttonClasses } from './button.tsx';
import { cx } from './cx.ts';
import { DANGER_SLIP_CLASSES, FormMessage, Notice } from './notice.tsx';
import { SubmitButton } from './submit-button.tsx';

/**
 * A destructive action behind a native disclosure: the first press only opens a danger slip
 * that names what will happen; the second, inside it, submits. No modal, works without
 * JavaScript, and a refusal from the server (409 "still in use") shows in the same slip.
 */
export function ConfirmAction({
  label,
  question,
  confirmLabel,
  action,
  hidden,
  children,
  className,
  isolated = true,
}: {
  label: string;
  question: ReactNode;
  confirmLabel: string;
  action: (prev: ManageState, formData: FormData) => Promise<ManageState>;
  /** Hidden fields (ids) sent with the confirmation. */
  hidden: Record<string, string>;
  /** Extra fields inside the slip (a checkbox). */
  children?: ReactNode;
  className?: string;
  /** Keep the destructive button's leading isolation space. */
  isolated?: boolean;
}) {
  const [state, formAction] = useActionState(action, {} as ManageState);
  const slipId = useId();
  if (state.notice && !state.message) {
    return <Notice tone="success">{state.notice}</Notice>;
  }
  return (
    <details className={cx('group', className)} open={state.message ? true : undefined}>
      <summary
        className={cx(
          buttonClasses({ variant: 'destructive', size: 'sm', isolated }),
          'cursor-pointer list-none [&::-webkit-details-marker]:hidden',
        )}
        aria-controls={slipId}
      >
        {label}
      </summary>
      <div id={slipId} className={cx(DANGER_SLIP_CLASSES, 'mt-3 max-w-[34rem]')}>
        <p className="text-pretty">{question}</p>
        <form action={formAction} className="flex flex-col gap-3">
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          {children}
          <FormMessage message={state.message} />
          <div>
            <SubmitButton variant="destructive" size="sm" isolated={false}>
              {confirmLabel}
            </SubmitButton>
          </div>
        </form>
      </div>
    </details>
  );
}
