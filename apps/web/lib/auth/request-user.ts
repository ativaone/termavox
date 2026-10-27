import '../server-guard.ts';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { SESSION_COOKIE } from '../auth-cookies.ts';
import { getAuthRuntime } from './server.ts';

export interface RequestUser {
  id: string;
  locale: string | null;
}

/**
 * The signed-in user of this request, for what the root layout renders before any page gate
 * runs: the language and the theme. Only looked up when a session cookie is present, so
 * anonymous pages (and anything rendered at build time, without configuration) never touch the
 * auth runtime or the database; once per request. Never an authorization check: pages and
 * actions keep using the auth gate.
 */
export const requestUser = cache(async (): Promise<RequestUser | null> => {
  const cookieStore = await cookies();
  if (!cookieStore.has(SESSION_COOKIE)) return null;
  try {
    const found = await getAuthRuntime().auth.api.getSession({
      headers: await headers(),
      query: { disableRefresh: true },
    });
    return found ? { id: found.user.id, locale: found.user.locale ?? null } : null;
  } catch {
    return null;
  }
});
