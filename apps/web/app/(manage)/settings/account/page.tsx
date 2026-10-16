import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { ChangePasswordForm } from '../../../../components/auth/change-password-form.tsx';
import { EnrollTotp } from '../../../../components/auth/enroll-totp.tsx';
import { LocaleSwitcher } from '../../../../components/locale-switcher.tsx';
import { DoneNotice } from '../../../../components/manage/done-notice.tsx';
import { DisableTotp } from '../../../../components/settings/disable-totp.tsx';
import { Notice } from '../../../../components/ui/notice.tsx';
import { SheetHeading } from '../../../../components/ui/page-header.tsx';
import { Panel, PanelSection } from '../../../../components/ui/panel.tsx';
import { Tag } from '../../../../components/ui/tag.tsx';
import { isLocale } from '../../../../i18n/locales.ts';
import { changePasswordInSettings } from '../../../../lib/actions/settings.ts';
import { isTotpRequiredInstanceWide } from '../../../../lib/auth/queries.ts';
import { getAuthRuntime, requireSession } from '../../../../lib/auth/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('settingsAccount') };
}

/** Account settings (plan §8.1): password, two-step verification, language. */
export default async function AccountSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const t = await getTranslations('settings.account');
  const locale = await getLocale();
  const enrolled = user.twoFactorEnabled === true;
  const required = user.totpRequired === true || isTotpRequiredInstanceWide(getAuthRuntime().db);
  const { done } = await searchParams;

  return (
    <>
      <DoneNotice done={done} messages={{ totpDisabled: t('totp.disabled') }} />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Panel aria-labelledby="password-title">
          <PanelSection>
            <SheetHeading
              id="password-title"
              title={t('password.title')}
              description={t('password.intro')}
            />
          </PanelSection>
          <PanelSection ruled>
            <ChangePasswordForm action={changePasswordInSettings} block={false} />
          </PanelSection>
        </Panel>
        <div className="flex flex-col gap-6">
          <Panel aria-labelledby="totp-title">
            <PanelSection>
              <SheetHeading
                id="totp-title"
                title={t('totp.title')}
                description={t('totp.intro')}
                action={
                  <Tag tone={enrolled ? 'success' : 'neutral'}>
                    {enrolled ? t('totp.on') : t('totp.off')}
                  </Tag>
                }
              />
            </PanelSection>
            <PanelSection ruled>
              {enrolled ? (
                required ? (
                  <Notice tone="info">{t('totp.requiredNote')}</Notice>
                ) : (
                  <DisableTotp />
                )
              ) : (
                <EnrollTotp
                  enrolled={false}
                  workspaceHref="/settings/account"
                  continueLabel={t('totp.done')}
                />
              )}
            </PanelSection>
          </Panel>
          <Panel aria-labelledby="language-title">
            <PanelSection>
              <SheetHeading
                id="language-title"
                title={t('language.title')}
                description={t('language.intro')}
              />
            </PanelSection>
            <PanelSection ruled>
              <LocaleSwitcher locale={isLocale(locale) ? locale : 'en'} hideLabel />
            </PanelSection>
          </Panel>
        </div>
      </div>
    </>
  );
}
