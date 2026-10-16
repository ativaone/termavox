import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SubNav } from '../../../components/manage/manage-nav.tsx';
import { PageHeader } from '../../../components/ui/page-header.tsx';
import { requireAdminPage } from '../../../lib/admin/page-guard.ts';

/** Admin area (plan §8.1): anyone but an admin gets the not-found page. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminPage();
  const t = await getTranslations('admin');
  return (
    <>
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} />
        <SubNav
          label={t('sections')}
          items={[
            { href: '/admin/users', label: t('users.tab') },
            { href: '/admin/settings', label: t('settings.tab') },
            { href: '/admin/audit', label: t('audit.tab') },
          ]}
        />
      </div>
      {children}
    </>
  );
}
