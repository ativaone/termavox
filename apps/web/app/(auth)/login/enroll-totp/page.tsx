import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthPanel } from '../../../../components/auth/auth-panel.tsx';
import { EnrollTotp } from '../../../../components/auth/enroll-totp.tsx';
import { SignOutButton } from '../../../../components/auth/sign-out-button.tsx';
import { authGate } from '../../../../lib/auth/gate.ts';
import { getAuthRuntime } from '../../../../lib/auth/server.ts';
import { liveRequestHeaders } from '../../../../lib/live-headers.ts';
import { ROUTES } from '../../../../lib/routes.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('enrollTotp') };
}

/**
 * Forced TOTP enrollment; serves the `totp-enrollment` requirement itself. Verifying the code
 * rotates the auth session and re-renders this route inside the same Server Action, so the gate
 * reads the live cookie store (not the stale request header), and the page never redirects on
 * `twoFactorEnabled`: the backup codes must stay on screen.
 */
export default async function EnrollTotpPage() {
  const gate = await authGate(getAuthRuntime(), await liveRequestHeaders(), {
    allow: ['totp-enrollment'],
  });
  if (!gate.ok) redirect(gate.redirectTo);
  const t = await getTranslations('auth.enrollTotp');
  const tc = await getTranslations('common');
  return (
    <AuthPanel
      title={t('title')}
      intro={t('intro')}
      wide
      footer={<SignOutButton label={tc('signOut')} />}
    >
      <EnrollTotp enrolled={gate.user.twoFactorEnabled === true} workspaceHref={ROUTES.workspace} />
    </AuthPanel>
  );
}
