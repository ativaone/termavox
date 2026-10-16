import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SubNav } from '../../../components/manage/manage-nav.tsx';
import { PageHeader } from '../../../components/ui/page-header.tsx';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('settings');
  return (
    <>
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} />
        <SubNav
          label={t('sections')}
          items={[
            { href: '/settings/account', label: t('account.tab') },
            { href: '/settings/terminal', label: t('terminal.tab') },
          ]}
        />
      </div>
      {children}
    </>
  );
}
