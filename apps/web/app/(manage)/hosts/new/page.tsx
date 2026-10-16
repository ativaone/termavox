import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HostForm } from '../../../../components/hosts/host-form.tsx';
import { PageHeader } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { getAuthRuntime, requireSession } from '../../../../lib/auth/server.ts';
import { localKindAvailability } from '../../../../lib/manage/local-kind.ts';
import { getInstanceSettings } from '../../../../lib/repo/instance-settings.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('hostNew') };
}

export default async function NewHostPage() {
  const { user } = await requireSession();
  const t = await getTranslations('hosts');
  const local = localKindAvailability(getInstanceSettings(getAuthRuntime().db), user.role);
  return (
    <>
      <PageHeader title={t('new.title')} description={t('new.intro')} />
      <Panel aria-label={t('new.title')} className="w-full max-w-[40rem]">
        <PanelSection>
          <HostForm
            initial={{ name: '', kind: 'ssh', hostname: '', port: '22' }}
            localAllowed={local.allowed}
            localReason={local.reason ? t(`form.localReason.${local.reason}`) : null}
            submitLabel={t('new.submit')}
          />
        </PanelSection>
      </Panel>
    </>
  );
}
