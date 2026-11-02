import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ThemeForm } from '../../../../components/settings/theme-form.tsx';
import { SectionHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { requireSession } from '../../../../lib/auth/server.ts';
import { requestTheme } from '../../../../lib/preferences/request-theme.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('settingsTheme') };
}

/** The interface theme (plan D-55, D-60): System, Light or Dark, stored per user. */
export default async function ThemeSettingsPage() {
  await requireSession();
  const t = await getTranslations('settings.theme');
  const theme = await requestTheme();
  return (
    <Panel aria-labelledby="theme-title">
      <PanelSection>
        <SectionHeading id="theme-title" title={t('title')} description={t('intro')} />
      </PanelSection>
      <PanelSection ruled>
        <ThemeForm theme={theme} />
      </PanelSection>
    </Panel>
  );
}
