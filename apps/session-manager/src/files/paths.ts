import { posix } from 'node:path';
import { FILES_LIMITS, fileNameProblem } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';

/**
 * Remote paths of the file panel (plan §5.12): absolute POSIX paths on the session's server. The
 * protocol schema already checked that a request's paths are absolute, NUL-free and bounded.
 */

/** `.`/`..` segments and repeated or trailing slashes resolved lexically: `/a/./b//` → `/a/b`. */
export function normalizePath(path: string): string {
  const normal = posix.normalize(path);
  return normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal;
}

export function joinPath(dir: string, name: string): string {
  return posix.join(dir, name);
}

/** A path that names an entry, split into its folder and its (valid) name. */
export interface NamedPath {
  /** Normalized: `parent` joined with `name`. */
  path: string;
  parent: string;
  name: string;
}

/**
 * A path whose last segment names the entry a request creates, renames or removes: that name must
 * pass `fileNameProblem` (NAME_INVALID), so `/`, `/a/..` or `/a/b/` never name one.
 */
export function namedPath(raw: string): NamedPath {
  const slash = raw.lastIndexOf('/');
  const name = raw.slice(slash + 1);
  checkName(name);
  const parent = normalizePath(raw.slice(0, slash) || '/');
  return { path: joinPath(parent, name), parent, name };
}

/** NAME_INVALID unless `name` can name a file or folder (shared rule with the browser). */
export function checkName(name: string): void {
  const problem = fileNameProblem(name);
  if (problem !== null) {
    throw new TermdockError(ErrorCode.NameInvalid, `invalid name (${problem})`, { problem });
  }
}

/** A path the server returned (realpath): usable only if absolute, NUL-free and bounded. */
export function isRemotePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    path.length <= FILES_LIMITS.path &&
    !path.includes('\0')
  );
}
