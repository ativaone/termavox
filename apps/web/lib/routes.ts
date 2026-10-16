import { AUTH_ROUTES } from './auth/gate.ts';

/** Page routes the UI links to. Auth routes come from the gate's table (single source). */
export const ROUTES = {
  ...AUTH_ROUTES,
  twoFactor: '/login/two-factor',
  workspace: '/workspace',
  /** Host management arrives with the management surfaces (plan §8.1). */
  hosts: '/hosts',
} as const;
