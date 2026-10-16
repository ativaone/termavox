import type { ReactNode } from 'react';
import { AlertIcon, CheckIcon, InfoIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';

export type NoticeTone = 'danger' | 'warning' | 'info' | 'success';

const TONE: Record<NoticeTone, { fill: string; icon: string }> = {
  danger: { fill: 'bg-danger-soft', icon: 'text-danger' },
  warning: { fill: 'bg-warning-soft', icon: 'text-state-reconnecting' },
  info: { fill: 'bg-info-soft', icon: 'text-accent' },
  success: { fill: 'bg-success-soft', icon: 'text-state-connected' },
};

export interface NoticeProps {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
}

/**
 * An inline notice: a soft tinted fill with a toned icon, the text in plain ink. Danger is
 * announced assertively (role=alert), everything else politely (role=status).
 */
export function Notice({ tone = 'info', title, children, id, className }: NoticeProps) {
  const style = TONE[tone];
  const Icon = tone === 'success' ? CheckIcon : tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <div
      id={id}
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx(
        'flex items-start gap-2.5 rounded-control px-3.5 py-3 text-base text-ink',
        style.fill,
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

/** The fill of a confirmation slip (a destructive action's question and its button). */
export const DANGER_SLIP_CLASSES =
  'flex flex-col gap-3 rounded-control bg-danger-soft px-3.5 py-3 text-base text-ink';
