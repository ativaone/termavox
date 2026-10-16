import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { WorkspaceShell } from '../../../components/workspace/workspace-shell.tsx';
import { isLocale } from '../../../i18n/locales.ts';
import { isAdminRole } from '../../../lib/admin/core.ts';
import { getAuthRuntime, requireSession } from '../../../lib/auth/server.ts';
import { countHosts } from '../../../lib/repo/hosts.ts';
import { getLayout } from '../../../lib/repo/layouts.ts';
import { getTerminalPreferences } from '../../../lib/repo/preferences.ts';
import { listProfilesForUser } from '../../../lib/repo/profiles.ts';
import { listBaySessions } from '../../../lib/repo/sessions.ts';
import { ROUTES } from '../../../lib/routes.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('workspace') };
}

/**
 * The default landing page (plan §8.1, §11.1). Everything the first paint needs comes from the
 * server (bay rows, the saved layout, profiles for the palette, terminal preferences); the live
 * WebSocket takes over in the browser. `?s=<sessionId>` follows one of your sessions.
 */
export default async function WorkspacePage() {
  const { user } = await requireSession();
  const { db } = getAuthRuntime();
  const locale = await getLocale();
  const profiles = listProfilesForUser(db, user.id).map(({ id, name, username, hostName }) => ({
    id,
    name,
    username,
    hostName,
  }));
  return (
    <WorkspaceShell
      bay={listBaySessions(db, user.id)}
      hostCount={countHosts(db, user.id)}
      renderedAt={Date.now()}
      username={user.username ?? user.name}
      locale={isLocale(locale) ? locale : 'en'}
      workspaceHref={ROUTES.workspace}
      hostsHref={ROUTES.hosts}
      loginHref={ROUTES.login}
      isAdmin={isAdminRole(user.role)}
      initialLayout={getLayout(db, user.id)}
      profiles={profiles}
      preferences={getTerminalPreferences(db, user.id)}
    />
  );
}
