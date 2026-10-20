import '../server-guard.ts';
import { isAdminRole } from '../admin/core.ts';

/**
 * Whether the host form may offer the local (direct-mode) kind (plan §10.2): an admin must have
 * made it visible (`local_shell_visible`), and only admins may use it. Direct mode also needs the
 * daemon flag (TERMAVOX_ENABLE_LOCAL_SHELL); the daemon enforces that at session start.
 */
export function localKindAvailability(
  settings: { localShellVisible: boolean },
  role: string | null | undefined,
): { allowed: boolean; reason: 'off' | 'adminOnly' | null } {
  if (!settings.localShellVisible) return { allowed: false, reason: 'off' };
  if (!isAdminRole(role)) return { allowed: false, reason: 'adminOnly' };
  return { allowed: true, reason: null };
}
