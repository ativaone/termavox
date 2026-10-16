import { remoteCommand } from '../drivers/tmux-control/commands.ts';
import { parseTmuxVersion, type TmuxVersion } from './tmux-version.ts';

export type Tristate = 'yes' | 'no' | 'unknown';

/** Typed capability probe result (plan §5.11). `raw` is what gets stored as `probe_json`. */
export interface ProbeResult {
  shell: string | null;
  /** Absolute path of the tmux binary, or null when tmux is absent. */
  tmuxPath: string | null;
  /** `tmux -V` output, e.g. `tmux 3.4`. */
  tmuxVersionRaw: string | null;
  tmuxVersion: TmuxVersion | null;
  /** A concrete installed UTF-8 locale name (as `locale -a` lists it), or null. */
  utf8Locale: string | null;
  /** terminfo for `tmux-256color` is installed. */
  tiTmux256: boolean;
  systemdRun: boolean;
  /** logind `KillUserProcesses` (unknown without systemd/logind). */
  killUserProcesses: Tristate;
  /** logind linger for the SSH user (unknown without systemd/logind). */
  linger: Tristate;
  raw: Record<string, string>;
}

/** Probe values are host-controlled: each one is cut to this many characters when parsed. */
export const PROBE_VALUE_MAX_LENGTH = 256;
/** `probe_json` (and a host test's `probe`) above this size is dropped (UTF-8 bytes). */
export const PROBE_JSON_MAX_BYTES = 16 * 1024;

const TMUX_FALLBACK_PATHS = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux'];
const TERMINFO_DIRS = [
  '"$HOME/.terminfo"',
  '/etc/terminfo',
  '/lib/terminfo',
  '/usr/share/terminfo',
];

/**
 * The probe as one POSIX script on a single line (csh cannot hold newlines inside quotes) and
 * without `!`. It sources nothing; every key is printed even when the value is unknown.
 */
export const PROBE_SCRIPT = [
  `printf 'shell=%s\\n' "$SHELL"`,
  'p=$(command -v tmux 2>/dev/null)',
  `case "$p" in /*) ;; *) p=; for c in ${TMUX_FALLBACK_PATHS.join(' ')}; do if [ -x "$c" ]; then p=$c; break; fi; done;; esac`,
  `if [ -n "$p" ]; then printf 'tmux_path=%s\\n' "$p"; printf 'tmux_version=%s\\n' "$("$p" -V 2>/dev/null | head -n 1)"; fi`,
  `l=$(locale -a 2>/dev/null | grep -ixE 'c\\.utf-?8' | head -n 1)`,
  `[ -n "$l" ] || l=$(locale -a 2>/dev/null | grep -ixE 'en_us\\.utf-?8' | head -n 1)`,
  `[ -n "$l" ] || l=$(locale -a 2>/dev/null | grep -iE '\\.utf-?8$' | head -n 1)`,
  // musl (Alpine) has no `locale -a` without musl-locales, but always supports C.UTF-8.
  `[ -n "$l" ] || { ls /lib/ld-musl-* >/dev/null 2>&1 && l=C.UTF-8; }`,
  `printf 'utf8_locale=%s\\n' "$l"`,
  `if infocmp tmux-256color >/dev/null 2>&1; then t=yes; else t=no; for d in ${TERMINFO_DIRS.join(' ')}; do if [ -e "$d/t/tmux-256color" ] || [ -e "$d/74/tmux-256color" ]; then t=yes; fi; done; fi`,
  `printf 'ti_tmux256=%s\\n' "$t"`,
  'if command -v systemd-run >/dev/null 2>&1; then echo systemd_run=yes; else echo systemd_run=no; fi',
  'k=$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2>/dev/null)',
  `case "$k" in 'b true') k=yes;; 'b false') k=no;; *) k=unknown;; esac`,
  `printf 'kill_user_processes=%s\\n' "$k"`,
  'g=$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null)',
  'case "$g" in Linger=yes) g=yes;; Linger=no) g=no;; *) g=unknown;; esac',
  `printf 'linger=%s\\n' "$g"`,
].join('; ');

/** The remote command for the probe exec channel: `exec sh -c '<PROBE_SCRIPT>'`. */
export function probeCommand(): string {
  return remoteCommand(PROBE_SCRIPT);
}

function tristate(value: string | undefined): Tristate {
  return value === 'yes' || value === 'no' ? value : 'unknown';
}

/** Cuts `value` to `max` UTF-16 units without splitting a surrogate pair. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = /[\uD800-\uDBFF]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return value.slice(0, end);
}

/**
 * Parses the probe output. Lines that are not `known_key=value` (e.g. noise printed by a
 * user's rc file before `exec sh`) are ignored; the last occurrence of a key wins. Values are
 * cut to PROBE_VALUE_MAX_LENGTH characters before anything stores or renders them.
 */
export function parseProbeOutput(output: string): ProbeResult {
  const raw: Record<string, string> = {};
  const known = new Set([
    'shell',
    'tmux_path',
    'tmux_version',
    'utf8_locale',
    'ti_tmux256',
    'systemd_run',
    'kill_user_processes',
    'linger',
  ]);
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (known.has(key)) {
      raw[key] = truncate(line.slice(eq + 1).replace(/\r$/, ''), PROBE_VALUE_MAX_LENGTH);
    }
  }
  const nonEmpty = (value: string | undefined): string | null => (value ? value : null);
  const tmuxPath = raw.tmux_path?.startsWith('/') ? raw.tmux_path : null;
  const tmuxVersionRaw = tmuxPath ? nonEmpty(raw.tmux_version) : null;
  return {
    shell: nonEmpty(raw.shell),
    tmuxPath,
    tmuxVersionRaw,
    tmuxVersion: tmuxVersionRaw ? parseTmuxVersion(tmuxVersionRaw) : null,
    utf8Locale: nonEmpty(raw.utf8_locale),
    tiTmux256: raw.ti_tmux256 === 'yes',
    systemdRun: raw.systemd_run === 'yes',
    killUserProcesses: tristate(raw.kill_user_processes),
    linger: tristate(raw.linger),
    raw,
  };
}

/** `raw` as stored in `probe_json` and returned by a host test: null when it is too large. */
export function storableProbe(raw: Record<string, string>): Record<string, string> | null {
  return Buffer.byteLength(JSON.stringify(raw), 'utf8') > PROBE_JSON_MAX_BYTES ? null : raw;
}
