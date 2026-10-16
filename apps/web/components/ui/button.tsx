import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';
import { cx } from './cx.ts';
import { Spinner } from './spinner.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonStyle {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width of the container. */
  block?: boolean;
  /** Icon-only control: square, the accessible name comes from aria-label. */
  iconOnly?: boolean;
}

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium ' +
  'transition-[background-color,border-color,color] duration-(--duration-step) ease-linear ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ' +
  'disabled:cursor-not-allowed aria-disabled:cursor-not-allowed';

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-sm',
  md: 'h-9 px-3.5 text-base',
  lg: 'h-11 px-4 text-md',
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: 'size-8',
  md: 'size-9',
  lg: 'size-11',
};

/*
 * Primary is the opposite stock of its surface: buff on the board, slate on buff.
 * Destructive is isolated by deliberate space (margin) from the actions beside it.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-pressed ' +
    'disabled:bg-disabled disabled:text-on-disabled',
  secondary:
    'border border-rule-strong bg-transparent text-ink hover:bg-quiet-hover active:bg-quiet-pressed ' +
    'disabled:border-rule disabled:bg-transparent disabled:text-ink-faint',
  quiet:
    'bg-transparent text-ink-muted hover:bg-quiet-hover hover:text-ink active:bg-quiet-pressed ' +
    'disabled:bg-transparent disabled:text-ink-faint',
  destructive:
    'ms-8 border border-danger bg-transparent text-danger hover:border-danger-fill hover:bg-danger-fill ' +
    'hover:text-white active:bg-danger-on-stock disabled:border-rule disabled:bg-transparent disabled:text-ink-faint',
};

export function buttonClasses({
  variant = 'secondary',
  size = 'md',
  block = false,
  iconOnly = false,
}: ButtonStyle = {}): string {
  return cx(BASE, iconOnly ? ICON_SIZE[size] : SIZE[size], VARIANT[variant], block && 'w-full');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyle {
  /** Working: shows a spinner, keeps the label, blocks repeat activation. */
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant,
  size,
  block,
  iconOnly,
  loading = false,
  icon,
  className,
  disabled,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonClasses({ variant, size, block, iconOnly }), className)}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & ButtonStyle & { icon?: ReactNode };

/** Navigation styled as a button (a link stays a link for assistive tech). */
export function ButtonLink({
  variant,
  size,
  block,
  iconOnly,
  icon,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link className={cx(buttonClasses({ variant, size, block, iconOnly }), className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}
