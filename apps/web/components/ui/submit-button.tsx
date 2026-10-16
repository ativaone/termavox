'use client';

import { useFormStatus } from 'react-dom';
import { Button, type ButtonProps } from './button.tsx';

/** A form's submit button: shows the working state while its Server Action runs. */
export function SubmitButton({
  variant = 'primary',
  ...props
}: Omit<ButtonProps, 'type' | 'loading'>) {
  const { pending } = useFormStatus();
  return <Button type="submit" variant={variant} loading={pending} {...props} />;
}
