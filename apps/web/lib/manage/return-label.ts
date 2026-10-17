import { ROUTES } from '../routes.ts';
import { safeReturnPath } from './return-to.ts';

/**
 * Which page a `?from=` value points back to (plan D-27), so the "Back to …" link can name it.
 * The raw value is read only through `safeReturnPath`; anything it drops gives null.
 */
export type ReturnPage =
  | { page: 'workspace' | 'servers' | 'addServer' | 'credentials'; href: string }
  | { page: 'server'; href: string; serverId: string };

export function returnPageOf(raw: unknown): ReturnPage | null {
  const href = safeReturnPath(raw);
  if (!href) return null;
  if (href === ROUTES.workspace) return { page: 'workspace', href };
  if (href === ROUTES.servers) return { page: 'servers', href };
  if (href === ROUTES.addServer) return { page: 'addServer', href };
  if (href === ROUTES.credentials) return { page: 'credentials', href };
  const serverId = href.slice(`${ROUTES.servers}/`.length);
  return { page: 'server', href, serverId };
}
