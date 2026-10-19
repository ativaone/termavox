import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { WorkspaceShell } from '../../../components/workspace/workspace-shell.tsx';
import { isLocale } from '../../../i18n/locales.ts';
import { isAdminRole } from '../../../lib/admin/core.ts';
import { getAuthRuntime, requireSession } from '../../../lib/auth/server.ts';
import { withReturnPath } from '../../../lib/manage/return-to.ts';
import { getInstanceSettings } from '../../../lib/repo/instance-settings.ts';
import { getLayout } from '../../../lib/repo/layouts.ts';
import { getTerminalPreferences } from '../../../lib/repo/preferences.ts';
import { listServers } from '../../../lib/repo/servers.ts';
import { listBaySessions } from '../../../lib/repo/sessions.ts';
import { ROUTES } from '../../../lib/routes.ts';
import { formatTarget } from '../../../lib/servers/target.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('workspace') };
}

/**
 * The default landing page (plan §8.1, §11.1). Everything the first paint needs comes from the
 * server (bay rows, the saved layout, the servers for the palette, terminal preferences); the
 * live WebSocket takes over in the browser. `?s=<sessionId>` follows one of your sessions.
 * `filesEnabled` (instance setting `file_transfer_enabled`, plan D-39) shows the file panel's
 * toggles; the daemon refuses file requests on its own when it is off.
 */
export default async function WorkspacePage() {
  const { user } = await requireSession();
  const { db } = getAuthRuntime();
  const locale = await getLocale();
  const t = await getTranslations('workspace');
  const servers = listServers(db, user.id).map((server) => ({
    id: server.id,
    name: server.name,
    target:
      server.kind === 'ssh' && server.hostname && server.port && server.username
        ? formatTarget(server.username, server.hostname, server.port)
        : t('localTarget'),
  }));
  return (
    <WorkspaceShell
      bay={listBaySessions(db, user.id)}
      serverCount={servers.length}
      renderedAt={Date.now()}
      username={user.username ?? user.name}
      locale={isLocale(locale) ? locale : 'en'}
      workspaceHref={ROUTES.workspace}
      serversHref={ROUTES.servers}
      addServerHref={withReturnPath(ROUTES.addServer, ROUTES.workspace)}
      loginHref={ROUTES.login}
      isAdmin={isAdminRole(user.role)}
      initialLayout={getLayout(db, user.id)}
      servers={servers}
      preferences={getTerminalPreferences(db, user.id)}
      filesEnabled={getInstanceSettings(db).fileTransferEnabled}
    />
  );
}
