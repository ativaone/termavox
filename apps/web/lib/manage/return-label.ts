import { ROUTES } from '../routes.ts';
import { safeReturnPath } from './return-to.ts';

/**
 * Which page a `?from=` value points back to (plan D-27), so the "Back to …" link can name it.
 * The raw value is read only through `safeReturnPath`; anything it drops gives null.
 */
export type ReturnPage =
  | { page: 'workspace' | 'hosts' | 'addServer' | 'credentials'; href: string }
  | { page: 'host'; href: string; hostId: string };

export function returnPageOf(raw: unknown): ReturnPage | null {
  const href = safeReturnPath(raw);
  if (!href) return null;
  if (href === ROUTES.workspace) return { page: 'workspace', href };
  if (href === ROUTES.hosts) return { page: 'hosts', href };
  if (href === ROUTES.addServer) return { page: 'addServer', href };
  if (href === ROUTES.credentials) return { page: 'credentials', href };
  const hostId = href.slice(`${ROUTES.hosts}/`.length);
  return { page: 'host', href, hostId };
}
