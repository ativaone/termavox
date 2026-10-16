import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { AuthPanel } from '../../../../components/auth/auth-panel.tsx';
import { TwoFactorForm } from '../../../../components/auth/two-factor-form.tsx';
import { buttonClasses } from '../../../../components/ui/button.tsx';
import { authGate } from '../../../../lib/auth/gate.ts';
import { getAuthRuntime } from '../../../../lib/auth/server.ts';
import { TWO_FACTOR_COOKIE } from '../../../../lib/auth-cookies.ts';
import { ROUTES } from '../../../../lib/routes.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('twoFactor') };
}

/** Second sign-in step. Without the pending-sign-in cookie there is nothing to verify. */
export default async function TwoFactorPage() {
  await connection();
  const gate = await authGate(getAuthRuntime(), await headers());
  if (gate.ok) redirect(ROUTES.workspace);
  if (gate.reason === 'setup-required') redirect(ROUTES.setup);
  if (!(await cookies()).has(TWO_FACTOR_COOKIE)) redirect(`${ROUTES.login}?notice=expired`);

  const t = await getTranslations('auth.twoFactor');
  return (
    <AuthPanel
      title={t('title')}
      intro={t('intro')}
      footer={
        <Link
          href={ROUTES.login}
          // Quiet text aligns with the sheet's content edge, not its own padding box.
          className={`${buttonClasses({ variant: 'quiet', size: 'sm' })} -ms-2.5`}
        >
          {t('otherAccount')}
        </Link>
      }
    >
      <TwoFactorForm />
    </AuthPanel>
  );
}
