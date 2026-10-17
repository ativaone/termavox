import '../server-guard.ts';
import { getTranslations } from 'next-intl/server';
import { getAuthRuntime } from '../auth/server.ts';
import { getHost } from '../repo/hosts.ts';
import { ROUTES } from '../routes.ts';
import { returnPageOf } from './return-label.ts';

export interface BackLink {
  href: string;
  label: string;
}

/**
 * The "Back to …" link for a page's `?from=` (plan D-27), named after the page it returns to, or
 * null when `from` names no allowed page. A host page that no longer exists (or is another
 * user's) falls back to the hosts list.
 */
export async function backLinkFrom(raw: unknown, userId: string): Promise<BackLink | null> {
  const target = returnPageOf(raw);
  if (!target) return null;
  const t = await getTranslations('hosts.back');
  if (target.page !== 'host') return { href: target.href, label: t(target.page) };
  const host = getHost(getAuthRuntime().db, userId, target.hostId);
  return host
    ? { href: target.href, label: t('host', { name: host.name }) }
    : { href: ROUTES.hosts, label: t('hosts') };
}
