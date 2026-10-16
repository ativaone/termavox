import { redirect } from 'next/navigation';
import { requireSession } from '../lib/auth/server.ts';
import { ROUTES } from '../lib/routes.ts';

// The gate sends visitors to setup, login or a pending requirement; everyone else works here.
export default async function Home() {
  await requireSession();
  redirect(ROUTES.workspace);
}
