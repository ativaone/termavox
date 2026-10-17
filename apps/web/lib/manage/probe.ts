import type { ProtectionMode } from '@termdock/protocol';

/**
 * Reads the capability probe report of "Test connection" (raw key/value output, plan §5.11) the
 * way the daemon decides protection, conservatively: tmux ≥ 3.2 with a UTF-8 locale runs
 * protected (tmux control mode); anything else, or protection off, runs unprotected.
 */

export interface ProbeSummary {
  tmuxPath: string | null;
  tmuxVersion: string | null;
  utf8Locale: string | null;
  shell: string | null;
  protection: 'tmux-control' | 'none';
  /** Why the session would not be protected, or null. */
  reason: 'off' | 'no_tmux' | 'too_old' | 'no_locale' | null;
  /** logind kills user processes and linger (or systemd-run) is missing (plan §5.11). */
  lingerWarning: boolean;
}

const OPENBSD_WITH_32 = [6, 9] as const;

/** Whether a `tmux -V` version is at least 3.2 (`3.4a`, `next-3.9`, `openbsd-7.6`, `master`). */
export function tmuxAtLeast32(raw: string): boolean {
  const v = raw.trim().replace(/^tmux\s+/, '');
  if (v === 'master') return true;
  let m = /^next-(\d+)\.(\d+)$/.exec(v) ?? /^(\d+)\.(\d+)[a-z]?(?:-rc\d*)?$/.exec(v);
  if (m) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const rc = /-rc/.test(v);
    if (major !== 3) return major > 3;
    return rc ? minor > 2 : minor >= 2;
  }
  m = /^openbsd-(\d+)\.(\d+)$/.exec(v);
  if (m) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return (
      major > OPENBSD_WITH_32[0] || (major === OPENBSD_WITH_32[0] && minor >= OPENBSD_WITH_32[1])
    );
  }
  return false;
}

export function summarizeProbe(
  raw: Record<string, string>,
  mode: ProtectionMode = 'auto',
): ProbeSummary {
  const tmuxPath = raw.tmux_path?.startsWith('/') ? raw.tmux_path : null;
  const tmuxVersion =
    tmuxPath && raw.tmux_version ? raw.tmux_version.replace(/^tmux\s+/, '') : null;
  const utf8Locale = raw.utf8_locale || null;
  let reason: ProbeSummary['reason'] = null;
  if (mode === 'off') reason = 'off';
  else if (!tmuxPath) reason = 'no_tmux';
  else if (!tmuxVersion || !tmuxAtLeast32(tmuxVersion)) reason = 'too_old';
  else if (!utf8Locale) reason = 'no_locale';
  return {
    tmuxPath,
    tmuxVersion,
    utf8Locale,
    shell: raw.shell || null,
    protection: reason === null ? 'tmux-control' : 'none',
    reason,
    lingerWarning:
      raw.kill_user_processes === 'yes' && (raw.linger !== 'yes' || raw.systemd_run !== 'yes'),
  };
}
