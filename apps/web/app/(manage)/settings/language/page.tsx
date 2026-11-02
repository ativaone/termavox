import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { LanguageForm } from '../../../../components/settings/language-form.tsx';
import { SectionHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { isLocale } from '../../../../i18n/locales.ts';
import { requireSession } from '../../../../lib/auth/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('settingsLanguage') };
}

/** The interface language (plan D-60), stored on the account, so it follows the user. */
export default async function LanguageSettingsPage() {
  await requireSession();
  const t = await getTranslations('settings.language');
  const locale = await getLocale();
  return (
    <Panel aria-labelledby="language-title">
      <PanelSection>
        <SectionHeading id="language-title" title={t('title')} description={t('intro')} />
      </PanelSection>
      <PanelSection ruled>
        <LanguageForm locale={isLocale(locale) ? locale : 'en'} />
      </PanelSection>
    </Panel>
  );
}
