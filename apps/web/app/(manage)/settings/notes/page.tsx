import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NotesForm } from '../../../../components/settings/notes-form.tsx';
import { SectionHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { getAuthRuntime, requireSession } from '../../../../lib/auth/server.ts';
import { getNotesPreferences } from '../../../../lib/repo/preferences.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('settingsNotes') };
}

/** How notes look (plan D-59): paper, font and size, apart from the terminal's own. */
export default async function NotesSettingsPage() {
  const { user } = await requireSession();
  const t = await getTranslations('settings.notes');
  const preferences = getNotesPreferences(getAuthRuntime().db, user.id);
  return (
    <Panel aria-labelledby="notes-title">
      <PanelSection>
        <SectionHeading id="notes-title" title={t('title')} description={t('intro')} />
      </PanelSection>
      <PanelSection ruled>
        <NotesForm initial={preferences} />
      </PanelSection>
    </Panel>
  );
}
