import { signOut } from '../../lib/actions/auth.ts';
import { SignOutIcon } from '../icons/index.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';

/** Sign-out as a form post (works without JavaScript; no state-changing GET). */
export function SignOutButton({
  label,
  iconOnly = false,
  className,
}: {
  label: string;
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <form action={signOut} className={className}>
      <SubmitButton
        variant="quiet"
        size="sm"
        iconOnly={iconOnly}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        icon={<SignOutIcon size={16} />}
      >
        {iconOnly ? null : label}
      </SubmitButton>
    </form>
  );
}
