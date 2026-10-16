import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthPanel } from '../../../../components/auth/auth-panel.tsx';
import { ChangePasswordForm } from '../../../../components/auth/change-password-form.tsx';
import { SignOutButton } from '../../../../components/auth/sign-out-button.tsx';
import { requireSession } from '../../../../lib/auth/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('changePassword') };
}

/** Forced (or voluntary) password change; serves the `password-change` requirement itself. */
export default async function ChangePasswordPage() {
  await requireSession({ allow: ['password-change'] });
  const t = await getTranslations('auth.changePassword');
  const tc = await getTranslations('common');
  return (
    <AuthPanel
      title={t('title')}
      intro={t('intro')}
      footer={<SignOutButton label={tc('signOut')} className="-ms-2.5" />}
    >
      <ChangePasswordForm />
    </AuthPanel>
  );
}
