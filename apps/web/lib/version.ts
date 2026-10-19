import './server-guard.ts';
import pkg from '../package.json';

/**
 * The running Termdock version: this package's `version`, inlined into the server bundle at
 * build time (`scripts/set-version.ts` sets it in every workspace manifest at release). It is
 * logged at startup (instrumentation.ts) and reaches the browser only as a prop of the account
 * menu, rendered by pages that already required a session; it is never part of a response a
 * signed-out visitor gets (sign-in, setup, error pages, `/api/health`, static assets).
 */
export const VERSION: string = pkg.version;
