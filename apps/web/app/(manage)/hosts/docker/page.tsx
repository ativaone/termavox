import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DockerPreset } from '../../../../components/hosts/docker-preset.tsx';
import { PageHeader } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { requireSession } from '../../../../lib/auth/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('dockerHost') };
}

export default async function DockerHostPage() {
  await requireSession();
  const t = await getTranslations('hosts.docker');
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
