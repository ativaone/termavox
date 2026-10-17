import '../server-guard.ts';
import { getTranslations } from 'next-intl/server';
import { getAuthRuntime } from '../auth/server.ts';
import { getServer } from '../repo/servers.ts';
import { ROUTES } from '../routes.ts';
import { returnPageOf } from './return-label.ts';

export interface BackLink {
  href: string;
  label: string;
}

/**
 * The "Back to …" link for a page's `?from=` (plan D-27), named after the page it returns to, or
 * null when `from` names no allowed page. A server page that no longer exists (or is another
 * user's) falls back to the servers list.
 */
export async function backLinkFrom(raw: unknown, userId: string): Promise<BackLink | null> {
  const target = returnPageOf(raw);
  if (!target) return null;
  const t = await getTranslations('servers.back');
  if (target.page !== 'server') return { href: target.href, label: t(target.page) };
  const server = getServer(getAuthRuntime().db, userId, target.serverId);
  return server
    ? { href: target.href, label: t('server', { name: server.name }) }
    : { href: ROUTES.servers, label: t('servers') };
}
