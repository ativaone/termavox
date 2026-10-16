import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { AuthPanel } from '../../../components/auth/auth-panel.tsx';
import { LoginForm } from '../../../components/auth/login-form.tsx';
import { authGate } from '../../../lib/auth/gate.ts';
import { getAuthRuntime } from '../../../lib/auth/server.ts';
import { ROUTES } from '../../../lib/routes.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('login') };
}

// Uses authGate, never requireSession(): this page must render for signed-out visitors.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const gate = await authGate(getAuthRuntime(), await headers());
  if (gate.ok) redirect(ROUTES.workspace);
  if (gate.reason !== 'unauthenticated' && gate.reason !== 'banned') redirect(gate.redirectTo);

  const t = await getTranslations('auth.login');
  const { notice } = await searchParams;
  return (
    <AuthPanel title={t('title')}>
      <LoginForm notice={notice === 'expired' ? t('notice.expired') : undefined} />
    </AuthPanel>
  );
}
