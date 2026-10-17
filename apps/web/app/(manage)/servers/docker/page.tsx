import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DockerPreset } from '../../../../components/servers/docker-preset.tsx';
import { PageHeader } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { requireSession } from '../../../../lib/auth/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('dockerServer') };
}

/** "Add this Docker host" (plan §13.4): a server at host.docker.internal with a new key. */
export default async function DockerServerPage() {
  await requireSession();
  const t = await getTranslations('servers.docker');
  return (
    <>
      <PageHeader title={t('title')} description={t('intro')} />
      <Panel aria-label={t('title')} className="w-full max-w-[44rem]">
        <PanelSection>
          <DockerPreset />
        </PanelSection>
      </Panel>
    </>
  );
}
