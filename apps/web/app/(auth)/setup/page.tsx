import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { AuthPanel } from '../../../components/auth/auth-panel.tsx';
import { SetupForm } from '../../../components/auth/setup-form.tsx';
import { isSetupOpen } from '../../../lib/auth/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('setup') };
}

/** First run only (plan §8.1): a 404 as soon as any user exists. */
export default async function SetupPage() {
  await connection();
  if (!isSetupOpen()) notFound();
  const t = await getTranslations('auth.setup');
  return (
    <AuthPanel title={t('title')} intro={t('intro')} wide>
      <SetupForm />
    </AuthPanel>
  );
}
