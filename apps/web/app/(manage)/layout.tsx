import type { ReactNode } from 'react';
import { ManageShell } from '../../components/manage/manage-shell.tsx';
import { isAdminRole } from '../../lib/admin/core.ts';
import { requireSession } from '../../lib/auth/server.ts';

/** Secondary pages around the workspace: hosts, credentials, activity, settings, admin. */
export default async function ManageLayout({ children }: { children: ReactNode }) {
  const { user } = await requireSession();
  return (
    <ManageShell username={user.username ?? user.name} isAdmin={isAdminRole(user.role)}>
      {children}
    </ManageShell>
  );
}
