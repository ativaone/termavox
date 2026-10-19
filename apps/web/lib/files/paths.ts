import { FILES_LIMITS } from '@termdock/protocol/client';

/**
 * POSIX paths on the session's server, as the file panel shows and edits them (plan §5.12).
 * Every path here is absolute; the daemon canonicalizes what it lists (links resolved), so these
 * helpers only do the lexical part. Framework-free.
 */

/** Collapses repeated slashes and resolves `.` and `..` lexically, never above `/`. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** `dir` joined with one entry name. */
export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

/** The folder holding `path`; the parent of `/` is `/`. */
export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const cut = normalized.lastIndexOf('/');
  return cut <= 0 ? '/' : normalized.slice(0, cut);
}

/** The last segment of `path` (`/` for the root). */
export function baseName(path: string): string {
  const normalized = normalizePath(path);
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** `path` is `dir` itself or somewhere below it. */
export function isWithin(path: string, dir: string): boolean {
  if (dir === '/') return path.startsWith('/');
  return path === dir || path.startsWith(`${dir}/`);
}

export interface Crumb {
  /** `home` stands for the user's home folder (drawn as a house), `root` for `/`. */
  kind: 'root' | 'home' | 'dir';
  name: string;
  path: string;
}

/**
 * The path bar's segments: from the home folder when `path` is inside it (the first segment is
 * the home itself), from `/` otherwise.
 */
export function breadcrumbs(path: string, home: string | null): Crumb[] {
  const normalized = normalizePath(path);
  const homeDir = home ? normalizePath(home) : null;
  const fromHome = homeDir !== null && homeDir !== '/' && isWithin(normalized, homeDir);
  const crumbs: Crumb[] = fromHome
    ? [{ kind: 'home', name: '~', path: homeDir }]
    : [{ kind: 'root', name: '/', path: '/' }];
  const rest = fromHome ? normalized.slice(homeDir.length) : normalized;
  let current = fromHome ? homeDir : '/';
  for (const name of rest.split('/')) {
    if (!name) continue;
    current = joinPath(current, name);
    crumbs.push({ kind: 'dir', name, path: current });
  }
  return crumbs;
}

/**
 * What the user typed in the path bar, as an absolute path: `~` and `~/…` start at `home`, a
 * relative path starts at `current`. Null when it cannot name a folder (empty, NUL, too long).
 */
export function resolvePathInput(
  input: string,
  { current, home }: { current: string; home: string | null },
): string | null {
  const text = input.trim();
  if (!text || text.includes('\0')) return null;
  let absolute: string;
  if (text === '~' || text.startsWith('~/')) {
    if (!home) return null;
    absolute = `${home}/${text.slice(1)}`;
  } else if (text.startsWith('/')) {
    absolute = text;
  } else {
    absolute = `${current}/${text}`;
  }
  const normalized = normalizePath(absolute);
  return normalized.length > FILES_LIMITS.path ? null : normalized;
}
