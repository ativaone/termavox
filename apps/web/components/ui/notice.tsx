import type { ReactNode } from 'react';
import { AlertIcon, CheckIcon, InfoIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';

export type NoticeTone = 'danger' | 'warning' | 'info' | 'success';

const TONE: Record<NoticeTone, { slip: string; icon: string }> = {
  danger: { slip: 'bg-tint-danger', icon: 'text-danger-on-stock' },
  warning: { slip: 'bg-tint-warning', icon: 'text-stock-ink' },
  info: { slip: 'bg-tint-info', icon: 'text-focus-stock' },
  success: { slip: 'bg-tint-success', icon: 'text-stock-ink' },
};

export interface NoticeProps {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
}

/**
 * An inline slip of tinted stock: the app's notice and form message. Danger is announced
 * assertively (role=alert), everything else politely (role=status). Text stays stock ink.
 */
export function Notice({ tone = 'info', title, children, id, className }: NoticeProps) {
  const style = TONE[tone];
  const Icon = tone === 'success' ? CheckIcon : tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <div
      id={id}
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx(
        'flex items-start gap-2.5 rounded-control px-3 py-2.5 text-base text-stock-ink',
        style.slip,
        className,
      )}
    >
      <Icon size={18} className={cx('mt-px shrink-0', style.icon)} />
      <div className="flex min-w-0 flex-col gap-0.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}

/** The form-level message of a Server Action result (empty renders nothing). */
export function FormMessage({ message, tone = 'danger' }: { message?: string; tone?: NoticeTone }) {
  if (!message) return null;
  return <Notice tone={tone}>{message}</Notice>;
}
