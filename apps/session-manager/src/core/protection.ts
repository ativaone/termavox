import type { ProfileProtection, Protection, ProtectionNotice } from '@termdock/protocol';
import { type ProbeResult, tmuxVersionAtLeast } from '../probe/index.ts';

export interface ProtectionChoice {
  protection: Protection;
  /** Why the session is not protected (shown to the user), or null. */
  notice: string | null;
  /** The same reason as a stable code (event details), or null. */
  code: ProtectionNotice | null;
}

/**
 * Protection selection (plan §5.11). tmux-normal ships in Phase 7; until then every case that
 * would select it runs unprotected with a notice.
 */
export function selectProtection(mode: ProfileProtection, probe: ProbeResult): ProtectionChoice {
  if (mode === 'off') return { protection: 'none', notice: null, code: null };
  if (!probe.tmuxPath) {
    return {
      protection: 'none',
      notice: 'tmux not found on the host: session not protected',
      code: 'tmux_missing',
    };
  }
  if (!probe.tmuxVersion || !tmuxVersionAtLeast(probe.tmuxVersion, 3, 2)) {
    const found = probe.tmuxVersionRaw ?? 'unknown version';
    return {
      protection: 'none',
      notice: `tmux too old (${found}): session not protected`,
      code: 'tmux_too_old',
    };
  }
  if (!probe.utf8Locale) {
    return {
      protection: 'none',
      notice: 'no UTF-8 locale on the host: session not protected',
      code: 'no_utf8',
    };
  }
  return { protection: 'tmux-control', notice: null, code: null };
}
