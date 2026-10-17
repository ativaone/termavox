import { AUTH_ROUTES } from './auth/routes.ts';

/**
 * Page routes the UI links to. Auth routes come from the gate's own table (single source), through
 * its pure module: this file is imported by client components, so it must never reach a
 * server-only module (`lib/auth/gate.ts` throws in a browser bundle).
 */
export const ROUTES = {
  ...AUTH_ROUTES,
  twoFactor: '/login/two-factor',
  workspace: '/workspace',
  /** The servers list (plan D-29); a server's page is `/servers/<id>`. */
  servers: '/servers',
  /** The single "Add server" form: the server and its credential (plan D-29). */
  addServer: '/servers/new',
  /** The "Add this Docker host" preset (plan §13.4). */
  dockerServer: '/servers/docker',
  credentials: '/credentials',
} as const;

/** A server's page. */
export function serverPath(serverId: string): string {
  return `${ROUTES.servers}/${encodeURIComponent(serverId)}`;
}

/** "Duplicate" (plan D-29): Add server prefilled from this server; nothing is saved until then. */
export function duplicateServerPath(serverId: string): string {
  return `${ROUTES.addServer}?duplicate=${encodeURIComponent(serverId)}`;
}
