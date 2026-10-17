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
  /** Host management arrives with the management surfaces (plan §8.1). */
  hosts: '/hosts',
  /** The single "Add server" form: host, sign-in profile and credential (plan D-27). */
  addServer: '/hosts/new',
  credentials: '/credentials',
} as const;
