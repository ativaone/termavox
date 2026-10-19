import { FILES_LIMITS, type FileEntry, type FileType } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { type SftpAttrs, type SftpDirEntry, type SftpSession, SftpStatus } from '../core/types.ts';
import { sftpStatus } from './errors.ts';
import { isRemotePath, joinPath, type NamedPath, normalizePath } from './paths.ts';

/**
 * The file panel's operations over an SFTP session (plan §5.12), whatever transport carries it.
 * Errors are the session's (SftpError) or Termdock's own (CONFLICT, CANCELLED, FILE_OP_FAILED);
 * the file service maps them for the browser.
 */

/** SFTP requests a listing (link targets) or a removal keeps in flight at most. */
export const FS_CONCURRENCY = 8;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
/** The longest name the protocol's FileEntry carries (UTF-16 units). */
const ENTRY_NAME_MAX = 1024;

export interface Listing {
  /** The folder's canonical path (links resolved). */
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface RemoveOptions {
  signal?: AbortSignal;
  /** Entries removed so far, after each one. */
  onProgress?: (removed: number) => void;
}

/** The user's home folder: where the server's SFTP starts (`realpath .`). */
export async function home(sftp: SftpSession): Promise<string> {
  return canonical(sftp, '.');
}

/**
 * A folder's entries as lstat sees them (a link is a link), each link with what it resolves to
 * (one `stat`) and its text (one `readlink`). Beyond `limit` entries the listing stops reading and
 * says `truncated`.
 */
export async function list(
  sftp: SftpSession,
  path: string,
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<Listing> {
  const { signal } = options;
  const folder = await canonical(sftp, normalizePath(path));
  const read = await readFolder(sftp, folder, options.limit ?? FILES_LIMITS.listEntries, signal);
  const raw = read.entries.filter((entry) => usableName(entry.name));
  const entries = raw.map((entry) => toEntry(entry.name, entry.attrs));
  const links = entries.flatMap((entry, index) => (entry.type === 'link' ? [index] : []));
  await eachLimit(links, FS_CONCURRENCY, async (index) => {
    throwIfCancelled(signal);
    const { name, attrs } = raw[index]!;
    entries[index] = toEntry(name, attrs, await linkInfo(sftp, joinPath(folder, name)));
  });
  return { path: folder, entries, truncated: read.truncated };
}

/** The entry at `path`, named `name` (lstat; a link with its target and text). */
export async function entryAt(sftp: SftpSession, path: string, name: string): Promise<FileEntry> {
  const attrs = await sftp.lstat(path);
  const link = fileType(attrs.mode) === 'link' ? await linkInfo(sftp, path) : undefined;
  return toEntry(name, attrs, link);
}

/** A new folder; an existing entry with that name is CONFLICT. */
export async function makeFolder(sftp: SftpSession, target: NamedPath): Promise<FileEntry> {
  if (await exists(sftp, target.path)) throw conflict();
  try {
    await sftp.mkdir(target.path);
  } catch (err) {
    // OpenSSH answers a generic FAILURE for an existing path: one created meanwhile.
    if (sftpStatus(err) === SftpStatus.Failure && (await exists(sftp, target.path))) {
      throw conflict();
    }
    throw err;
  }
  return entryAt(sftp, target.path, target.name);
}

/** Renames or moves an entry; never replaces one (CONFLICT). */
export async function rename(
  sftp: SftpSession,
  from: NamedPath,
  to: NamedPath,
): Promise<FileEntry> {
  if (await exists(sftp, to.path)) throw conflict();
  try {
    await sftp.rename(from.path, to.path);
  } catch (err) {
    if (sftpStatus(err) === SftpStatus.Failure && (await exists(sftp, to.path))) throw conflict();
    throw err;
  }
  return entryAt(sftp, to.path, to.name);
}

/**
 * Removes entries, folders with everything inside, depth first. Every decision comes from the
 * lstat view: a link is unlinked and never followed, and a folder is only entered after an lstat of
 * its own path says it is one. An entry already gone counts as removed by someone else (skipped).
 * Resolves with the number of entries removed; an abort stops it between requests (CANCELLED).
 */
export async function remove(
  sftp: SftpSession,
  targets: readonly NamedPath[],
  options: RemoveOptions = {},
): Promise<number> {
  const { signal, onProgress } = options;
  let removed = 0;
  const count = (gone: boolean): void => {
    if (!gone) return;
    removed++;
    onProgress?.(removed);
  };
  const removeTree = async (path: string): Promise<void> => {
    throwIfCancelled(signal);
    const attrs = await lstatOrNull(sftp, path);
    if (!attrs) return;
    if (fileType(attrs.mode) !== 'dir') {
      count(await done(sftp.unlink(path)));
      return;
    }
    const { entries } = await readFolder(sftp, path, Number.POSITIVE_INFINITY, signal);
    const children = entries.filter((entry) => entry.name !== '.' && entry.name !== '..');
    // Never a folder for its own listing: unlinked at once, a few at a time. A child the listing
    // calls a folder goes through removeTree, whose lstat decides again.
    const folders = children.filter((entry) => fileType(entry.attrs.mode) === 'dir');
    const others = children.filter((entry) => fileType(entry.attrs.mode) !== 'dir');
    await eachLimit(others, FS_CONCURRENCY, async (entry) => {
      throwIfCancelled(signal);
      count(await done(sftp.unlink(joinPath(path, entry.name))));
    });
    for (const entry of folders) await removeTree(joinPath(path, entry.name));
    throwIfCancelled(signal);
    count(await done(sftp.rmdir(path)));
  };
  for (const target of targets) await removeTree(target.path);
  return removed;
}

// ── entries ──────────────────────────────────────────────────────────────────────────────────

export function fileType(mode: number): FileType {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'link';
    default:
      return 'other';
  }
}

interface LinkInfo {
  /** What the link resolves to (stat), or null when it dangles or cannot be read. */
  target: SftpAttrs | null;
  linkTo: string | null;
}

/** The protocol's FileEntry: type from the mode bits, mtime in ms, permission bits only. */
export function toEntry(name: string, attrs: SftpAttrs, link?: LinkInfo): FileEntry {
  const entry: FileEntry = {
    name,
    type: fileType(attrs.mode),
    size: attrs.size,
    mtime: attrs.mtime * 1000,
    mode: attrs.mode & 0o7777,
  };
  if (entry.type !== 'link' || !link) return entry;
  const target = link.target ? fileType(link.target.mode) : null;
  entry.target = target === 'link' ? 'other' : target;
  if (link.target && target === 'file') entry.size = link.target.size;
  if (link.linkTo !== null && link.linkTo.length <= FILES_LIMITS.path) entry.linkTo = link.linkTo;
  return entry;
}

async function linkInfo(sftp: SftpSession, path: string): Promise<LinkInfo> {
  const target = await unlessFailed(sftp.stat(path));
  const linkTo = await unlessFailed(sftp.readlink(path));
  return { target, linkTo };
}

/** A link that dangles, loops or cannot be read still lists; a lost channel still fails. */
async function unlessFailed<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (err) {
    const status = sftpStatus(err);
    if (status === null || status === SftpStatus.ConnectionLost) throw err;
    if (status === SftpStatus.NoConnection) throw err;
    return null;
  }
}

/** Names the protocol can carry; anything else a server may send is left out of a listing. */
function usableName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= ENTRY_NAME_MAX &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0')
  );
}

// ── requests ─────────────────────────────────────────────────────────────────────────────────

async function canonical(sftp: SftpSession, path: string): Promise<string> {
  const resolved = await sftp.realpath(path);
  if (!isRemotePath(resolved)) {
    throw new TermdockError(ErrorCode.FileOpFailed, 'the server returned an unusable path');
  }
  return resolved;
}

/**
 * A folder's entries (`.` and `..` left out), read until its end or until more than `limit` were
 * seen. The handle is always closed.
 */
async function readFolder(
  sftp: SftpSession,
  path: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ entries: SftpDirEntry[]; truncated: boolean }> {
  const handle = await sftp.opendir(path);
  const entries: SftpDirEntry[] = [];
  try {
    for (;;) {
      throwIfCancelled(signal);
      const batch = await sftp.readdir(handle);
      if (batch === null) return { entries, truncated: false };
      for (const entry of batch) {
        if (entry.name === '.' || entry.name === '..') continue;
        if (entries.length === limit) return { entries, truncated: true };
        entries.push(entry);
      }
    }
  } finally {
    await sftp.close(handle).catch(() => {});
  }
}

async function exists(sftp: SftpSession, path: string): Promise<boolean> {
  return (await lstatOrNull(sftp, path)) !== null;
}

async function lstatOrNull(sftp: SftpSession, path: string): Promise<SftpAttrs | null> {
  try {
    return await sftp.lstat(path);
  } catch (err) {
    if (sftpStatus(err) === SftpStatus.NoSuchFile) return null;
    throw err;
  }
}

/** True once the entry is gone; false when it already was (NO_SUCH_FILE). */
async function done(request: Promise<void>): Promise<boolean> {
  try {
    await request;
    return true;
  } catch (err) {
    if (sftpStatus(err) === SftpStatus.NoSuchFile) return false;
    throw err;
  }
}

/**
 * `fn` for every item, at most `limit` at a time. The first failure stops the workers from taking
 * more items and is thrown once the requests already running have settled: nothing runs after the
 * caller has its answer.
 */
async function eachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { err: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { err: unknown }).err;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TermdockError(ErrorCode.Cancelled, 'cancelled');
}

function conflict(): TermdockError {
  return new TermdockError(ErrorCode.Conflict, 'a file or folder with this name already exists');
}
