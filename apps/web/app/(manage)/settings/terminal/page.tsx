import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TerminalForm } from '../../../../components/settings/terminal-form.tsx';
import { SheetHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { getAuthRuntime, requireSession } from '../../../../lib/auth/server.ts';
import { getTerminalPreferences } from '../../../../lib/repo/preferences.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('settingsTerminal') };
}

/** Terminal preferences: font, size, colour scheme, cursor, clipboard and link safety. */
export default async function TerminalSettingsPage() {
  const { user } = await requireSession();
  const t = await getTranslations('settings.terminal');
  const preferences = getTerminalPreferences(getAuthRuntime().db, user.id);
  return (
    <Panel aria-labelledby="terminal-title">
      <PanelSection>
        <SheetHeading id="terminal-title" title={t('title')} description={t('intro')} />
      </PanelSection>
      <PanelSection ruled>
        <TerminalForm initial={preferences} />
      </PanelSection>
    </Panel>
  );
}
