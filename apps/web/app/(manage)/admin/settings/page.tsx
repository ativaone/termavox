import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InstanceSettingsForm } from '../../../../components/admin/settings-form.tsx';
import { SheetHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { requireAdminPage } from '../../../../lib/admin/page-guard.ts';
import { getAuthRuntime } from '../../../../lib/auth/server.ts';
import { getInstanceSettings } from '../../../../lib/repo/instance-settings.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('adminSettings') };
}

export default async function AdminSettingsPage() {
  await requireAdminPage();
  const t = await getTranslations('admin.settings');
  const settings = getInstanceSettings(getAuthRuntime().db);
  return (
    <Panel aria-labelledby="instance-title" className="w-full max-w-[48rem]">
      <PanelSection>
        <SheetHeading id="instance-title" title={t('title')} description={t('intro')} />
      </PanelSection>
      <PanelSection ruled>
        <InstanceSettingsForm initial={settings} />
      </PanelSection>
    </Panel>
  );
}
