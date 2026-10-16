import 'server-only';
import { notFound } from 'next/navigation';
import type { AuthSession } from '../auth/auth.ts';
import { requireSession } from '../auth/server.ts';
import { isAdminRole } from './core.ts';

/** Admin pages: the usual gate (login, pending requirements), then 404 for anyone but an admin. */
export async function requireAdminPage(): Promise<AuthSession> {
  const session = await requireSession();
  if (!isAdminRole(session.user.role)) notFound();
  return session;
}
