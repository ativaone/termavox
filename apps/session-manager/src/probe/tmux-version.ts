/** A comparable tmux version (plan §5.11: `3.4`, `3.2a`, `next-3.9`, `openbsd-7.6` must parse). */
export interface TmuxVersion {
  major: number;
  minor: number;
  /** '' for an X.Y release, 'a', 'b', … for patch releases. */
  patch: string;
  /** Release candidate (`3.3-rc`): sorts before the X.Y release. */
  prerelease: boolean;
  /** Development build (`next-X.Y`, `master`): sorts after every X.Y release. */
  next: boolean;
  /** Derived from an OpenBSD base-system release: a lower bound, not an exact version. */
  approximate: boolean;
  /** The version string as reported (without the `tmux ` prefix). */
  raw: string;
}

/**
 * OpenBSD ships tmux from the upstream development tree, so `openbsd-X.Y` is at least the
 * newest portable release published before that OpenBSD release. Values are lower bounds.
 */
const OPENBSD_FLOOR: ReadonlyArray<readonly [number, number, number, number, string]> = [
  // [obsdMajor, obsdMinor, tmuxMajor, tmuxMinor, patch]
  [6, 9, 3, 2, ''],
  [7, 0, 3, 2, 'a'],
  [7, 2, 3, 3, 'a'],
  [7, 5, 3, 4, ''],
  [7, 6, 3, 5, ''],
  [7, 7, 3, 5, 'a'],
];
/** Below the first table row: older than tmux 3.2 (control mode not supported). */
const OPENBSD_PRE_TABLE = { major: 3, minor: 1, patch: '' };
/** `master` builds: newer than the newest release we know of. */
const LATEST_KNOWN = { major: 3, minor: 8 };

/** Parses `tmux -V` output or a bare version. Returns null when unrecognised. */
export function parseTmuxVersion(input: string): TmuxVersion | null {
  const raw = input.trim().replace(/^tmux\s+/, '');
  const base = { patch: '', prerelease: false, next: false, approximate: false, raw };

  let match = /^next-(\d+)\.(\d+)$/.exec(raw);
  if (match) return { ...base, major: Number(match[1]), minor: Number(match[2]), next: true };

  if (raw === 'master') return { ...base, ...LATEST_KNOWN, next: true };

  match = /^openbsd-(\d+)\.(\d+)$/.exec(raw);
  if (match) {
    const obsd = [Number(match[1]), Number(match[2])] as const;
    let floor: { major: number; minor: number; patch: string } = OPENBSD_PRE_TABLE;
    for (const [oMajor, oMinor, major, minor, patch] of OPENBSD_FLOOR) {
      if (obsd[0] > oMajor || (obsd[0] === oMajor && obsd[1] >= oMinor)) {
        floor = { major, minor, patch };
      }
    }
    return { ...base, ...floor, approximate: true };
  }

  match = /^(\d+)\.(\d+)([a-z]?)(-rc\d*)?$/.exec(raw);
  if (match) {
    return {
      ...base,
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: match[3] ?? '',
      prerelease: match[4] !== undefined,
    };
  }
  return null;
}

function patchRank(v: Pick<TmuxVersion, 'patch' | 'prerelease' | 'next'>): number {
  if (v.next) return 1_000;
  if (v.prerelease) return -1;
  return v.patch === '' ? 0 : v.patch.charCodeAt(0) - 0x60;
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareTmuxVersions(
  a: Pick<TmuxVersion, 'major' | 'minor' | 'patch' | 'prerelease' | 'next'>,
  b: Pick<TmuxVersion, 'major' | 'minor' | 'patch' | 'prerelease' | 'next'>,
): number {
  return a.major - b.major || a.minor - b.minor || patchRank(a) - patchRank(b);
}

/** True when `v` is at least `major.minor[patch]`. */
export function tmuxVersionAtLeast(
  v: TmuxVersion,
  major: number,
  minor: number,
  patch = '',
): boolean {
  return compareTmuxVersions(v, { major, minor, patch, prerelease: false, next: false }) >= 0;
}
