import { FILES_LIMITS, type FileEntry, type FileType } from '@termavox/protocol';
import { ErrorCode, TermavoxError } from '@termavox/shared';
import { type SftpAttrs, type SftpDirEntry, type SftpSession, SftpStatus } from '../core/types.ts';
import { sftpStatus } from './errors.ts';
import { isRemotePath, joinPath, type NamedPath, normalizePath } from './paths.ts';

/**
 * The file panel's operations over an SFTP session (plan §5.12), whatever transport carries it.
 * Errors are the session's (SftpError) or Termavox's own (CONFLICT, CANCELLED, FILE_OP_FAILED,
 * REMOVE_TOO_LARGE); the file service maps them for the browser.
 */

/** SFTP requests a listing (link targets) or a removal keeps in flight at most. */
export const FS_CONCURRENCY = 8;
/** Bytes (UTF-8) of names and link texts one listing holds at most; beyond, it is `truncated`. */
export const LIST_BYTES_MAX = 2 * 1024 * 1024;
/** The longest link text a listing reports (UTF-16 units); a longer one is left out. */
export const LINK_TEXT_MAX = 1024;
/** Folder levels one removal enters at most, the folder it was asked to remove being the first. */
export const REMOVE_DEPTH_MAX = 64;
/**
 * Entries one removal reads at most, over every folder it lists (an answer without a name counting
 * as one).
 */
export const REMOVE_ENTRIES_MAX = 100_000;
/** Bytes (UTF-8) of names one removal reads at most, over every folder it lists. */
export const REMOVE_NAME_BYTES_MAX = 32 * 1024 * 1024;

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
 * (one `stat`) and its text (one `readlink`). Beyond `limit` entries, or LIST_BYTES_MAX bytes of
 * names and link texts, the listing stops reading and says `truncated`.
 */
export async function list(
  sftp: SftpSession,
  path: string,
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<Listing> {
  const { signal } = options;
  const folder = await canonical(sftp, normalizePath(path));
  const read = await readFolder(sftp, folder, options.limit ?? FILES_LIMITS.listEntries, signal);
  const entries = read.entries.map((entry) => toEntry(entry.name, entry.attrs));
  const links = entries.flatMap((entry, index) => (entry.type === 'link' ? [index] : []));
  // Link texts share the byte budget: a link whose text no longer fits cuts the listing before it.
  // Links are taken in order, so every link before the cut was resolved, and fitted.
  let bytes = read.bytes;
  let cut = entries.length;
  await eachLimit(links, FS_CONCURRENCY, async (index) => {
    throwIfCancelled(signal);
    if (index >= cut) return;
    const { name, attrs } = read.entries[index]!;
    const entry = toEntry(name, attrs, await linkInfo(sftp, joinPath(folder, name)));
    const size = Buffer.byteLength(entry.linkTo ?? '', 'utf8');
    if (bytes + size > LIST_BYTES_MAX) {
      cut = Math.min(cut, index);
      return;
    }
    bytes += size;
    entries[index] = entry;
  });
  const truncated = read.truncated || cut < entries.length;
  entries.splice(cut);
  return { path: folder, entries, truncated };
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
 * A folder is listed once, to its end, and closed before anything in it is removed: it is never
 * read on after its own deletions (a server may skip entries then) nor opened again, and one folder
 * is open at a time. Of each entry, only its name waits, and whether the listing calls it a folder.
 * A name that cannot be a child's (the server sends what it likes: `..`, `a/b`, an empty one) is
 * skipped, never joined to the path. Past REMOVE_DEPTH_MAX folder levels, or REMOVE_ENTRIES_MAX
 * entries or REMOVE_NAME_BYTES_MAX bytes of names read over the whole removal, it stops
 * (REMOVE_TOO_LARGE); what it removed stays removed. Resolves with the number of entries removed; an
 * abort stops it between requests (CANCELLED).
 */
export async function remove(
  sftp: SftpSession,
  targets: readonly NamedPath[],
  options: RemoveOptions = {},
): Promise<number> {
  const { signal, onProgress } = options;
  let removed = 0;
  // What the removal has read, over every folder of every level and target.
  let listed = 0;
  let nameBytes = 0;
  const count = (gone: boolean): void => {
    if (!gone) return;
    removed++;
    onProgress?.(removed);
  };
  const removeTree = async (path: string, level: number): Promise<void> => {
    throwIfCancelled(signal);
    const attrs = await lstatOrNull(sftp, path);
    if (!attrs) return;
    if (fileType(attrs.mode) !== 'dir') {
      count(await done(sftp.unlink(path)));
      return;
    }
    if (level > REMOVE_DEPTH_MAX) throw tooBig('deep');
    const files: string[] = [];
    const folders: string[] = [];
    await eachBatch(sftp, path, signal, (batch) => {
      listed += Math.max(1, batch.length);
      for (const entry of batch) nameBytes += Buffer.byteLength(entry.name, 'utf8');
      if (listed > REMOVE_ENTRIES_MAX || nameBytes > REMOVE_NAME_BYTES_MAX) throw tooBig('large');
      for (const entry of batch) {
        if (!usableName(entry.name)) continue;
        if (fileType(entry.attrs.mode) === 'dir') folders.push(entry.name);
        else files.push(entry.name);
      }
      return true;
    });
    // Never a folder for its own listing: unlinked, a few at a time. A child the listing calls a
    // folder goes through removeTree, whose lstat decides again.
    await eachLimit(files, FS_CONCURRENCY, async (name) => {
      throwIfCancelled(signal);
      count(await done(sftp.unlink(joinPath(path, name))));
    });
    for (const name of folders) await removeTree(joinPath(path, name), level + 1);
    throwIfCancelled(signal);
    count(await done(sftp.rmdir(path)));
  };
  for (const target of targets) await removeTree(target.path, 1);
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
  if (link.linkTo !== null && link.linkTo.length <= LINK_TEXT_MAX) entry.linkTo = link.linkTo;
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
    throw new TermavoxError(ErrorCode.FileOpFailed, 'the server returned an unusable path');
  }
  return resolved;
}

/**
 * A folder's entries with usable names, read until its end or until more than `limit` names or
 * LIST_BYTES_MAX bytes (UTF-8) of names came (`truncated`; `bytes` is what they used). Every name
 * counts, kept or not: one the protocol cannot carry is dropped as it comes, but still uses its
 * share, and an answer without a name counts as one, so no server can keep a listing reading.
 */
async function readFolder(
  sftp: SftpSession,
  path: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ entries: SftpDirEntry[]; bytes: number; truncated: boolean }> {
  const entries: SftpDirEntry[] = [];
  let seen = 0;
  let bytes = 0;
  const ended = await eachBatch(sftp, path, signal, (batch) => {
    if (batch.length === 0) {
      if (seen === limit) return false;
      seen++;
    }
    for (const entry of batch) {
      const size = Buffer.byteLength(entry.name, 'utf8');
      if (seen === limit || bytes + size > LIST_BYTES_MAX) return false;
      seen++;
      bytes += size;
      if (usableName(entry.name)) entries.push(entry);
    }
    return true;
  });
  return { entries, bytes, truncated: !ended };
}

/**
 * Hands a folder's readdir answers to `take` one at a time, until the folder ends (true) or `take`
 * returns false (false); the handle is always closed, whatever `take` does. The folder's own `.`
 * and `..` are left out, once each: anything else the server sends, another `.` included, reaches
 * `take`, which bounds what it reads by counting it. Only the end of the folder ends it: an answer
 * may reach `take` without a name (ssh2 drops every `.` and `..`, so an answer holding only those
 * arrives empty), and `take` counts that one too.
 */
async function eachBatch(
  sftp: SftpSession,
  path: string,
  signal: AbortSignal | undefined,
  take: (batch: SftpDirEntry[]) => boolean,
): Promise<boolean> {
  throwIfCancelled(signal);
  const handle = await sftp.opendir(path);
  const dots = new Set<string>();
  const ownDot = (name: string): boolean => {
    if ((name !== '.' && name !== '..') || dots.has(name)) return false;
    dots.add(name);
    return true;
  };
  try {
    for (;;) {
      throwIfCancelled(signal);
      const answer = await sftp.readdir(handle);
      if (answer === null) return true;
      if (!take(answer.filter((entry) => !ownDot(entry.name)))) return false;
    }
  } finally {
    await sftp.close(handle).catch(() => {});
  }
}

async function exists(sftp: SftpSession, path: string): Promise<boolean> {
  return (await lstatOrNull(sftp, path)) !== null;
}

/** The entry itself, or null when nothing has that name. */
export async function lstatOrNull(sftp: SftpSession, path: string): Promise<SftpAttrs | null> {
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
  if (signal?.aborted) throw new TermavoxError(ErrorCode.Cancelled, 'cancelled');
}

function conflict(): TermavoxError {
  return new TermavoxError(ErrorCode.Conflict, 'a file or folder with this name already exists');
}

/**
 * A removal past REMOVE_DEPTH_MAX (`deep`), REMOVE_ENTRIES_MAX or REMOVE_NAME_BYTES_MAX (`large`):
 * one code for the browser, which words it in the user's language; the message says which bound,
 * for the logs.
 */
function tooBig(what: 'deep' | 'large'): TermavoxError {
  const message = `the folder is too ${what} to delete from the panel`;
  return new TermavoxError(ErrorCode.RemoveTooLarge, message);
}
