import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { WorkspaceShell } from '../../../components/workspace/workspace-shell.tsx';
import { isLocale } from '../../../i18n/locales.ts';
import { isAdminRole } from '../../../lib/admin/core.ts';
import { getAuthRuntime, requireSession } from '../../../lib/auth/server.ts';
import { countHosts } from '../../../lib/repo/hosts.ts';
import { listBaySessions } from '../../../lib/repo/sessions.ts';
import { ROUTES } from '../../../lib/routes.ts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('workspace') };
}

/** The default landing page (plan §8.1, §11.1). `?s=<sessionId>` follows one of your sessions. */
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const { db } = getAuthRuntime();
  const bay = listBaySessions(db, user.id);
  const { s } = await searchParams;
  const followedId = typeof s === 'string' && bay.sessions.some((x) => x.id === s) ? s : null;
  const locale = await getLocale();
  return (
    <WorkspaceShell
      bay={bay}
      hostCount={countHosts(db, user.id)}
      followedId={followedId}
      renderedAt={Date.now()}
      username={user.username ?? user.name}
      locale={isLocale(locale) ? locale : 'en'}
      workspaceHref={ROUTES.workspace}
      hostsHref={ROUTES.hosts}
      isAdmin={isAdminRole(user.role)}
    />
  );
}
