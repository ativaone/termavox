import 'server-only';
import { cookies, headers } from 'next/headers';

/**
 * The request headers with the `Cookie` header rebuilt from Next's cookie store. After a Server
 * Action rotates the auth session (TOTP enrollment does), Next re-renders the route in the same
 * request: `cookies()` already holds the new session cookie, but `headers()` still carries the
 * old one, which Better Auth has deleted. Pages re-rendered after such an action gate on these.
 */
export async function liveRequestHeaders(): Promise<Headers> {
  const result = new Headers(await headers());
  const all = (await cookies()).getAll();
  if (all.length === 0) result.delete('cookie');
  else {
    result.set(
      'cookie',
      all.map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; '),
    );
  }
  return result;
}
