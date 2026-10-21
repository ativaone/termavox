import { randomBytes } from 'node:crypto';
import { FILES_LIMITS } from '@termavox/protocol';
import { ErrorCode, TermavoxError } from '@termavox/shared';
import { type SftpAttrs, type SftpSession, SftpStatus } from '../core/types.ts';
import { sftpStatus } from './errors.ts';
import { joinPath, type NamedPath } from './paths.ts';
import { fileType, lstatOrNull } from './remote-fs.ts';

/**
 * The file-system side of the transfers (plan §5.12), over an SFTP session: where an upload may
 * go, its temporary file, putting it in place, and what may be downloaded.
 */

const encoder = new TextEncoder();
/** `.<name>.tv-<8 hex>.part` around the name. */
const TEMP_PREFIX = '.';
const TEMP_MARK = '.tv-';
const TEMP_SUFFIX = '.part';

/** What an upload replaces: the permission bits to keep (null for a dangling link). */
interface Replaced {
  mode: number | null;
}

/**
 * The temporary name an upload writes to before it is put in place: hidden, recognizable, unique,
 * and within NAME_MAX (a long name loses its middle).
 */
export function tempName(name: string, random = randomBytes(4).toString('hex')): string {
  const fixed = encoder.encode(`${TEMP_PREFIX}${TEMP_MARK}${random}${TEMP_SUFFIX}`).byteLength;
  return `${TEMP_PREFIX}${shortenMiddle(name, FILES_LIMITS.nameBytes - fixed)}${TEMP_MARK}${random}${TEMP_SUFFIX}`;
}

function shortenMiddle(name: string, maxBytes: number): string {
  if (encoder.encode(name).byteLength <= maxBytes) return name;
  const chars = [...name];
  const head = chars.slice(0, Math.ceil(chars.length / 2));
  const tail = chars.slice(head.length);
  const joined = (): string => `${head.join('')}~${tail.join('')}`;
  while (encoder.encode(joined()).byteLength > maxBytes) {
    if (head.length >= tail.length) head.pop();
    else tail.shift();
  }
  return joined();
}

/**
 * Where an upload into `dir` named `name` goes (checked when its URL is minted). `dir` must be a
 * folder (links followed). An existing name is CONFLICT without `overwrite`, and always when it is a
 * folder or a link to one: an upload replaces files only.
 */
export async function uploadTarget(
  sftp: SftpSession,
  dir: string,
  name: string,
  overwrite: boolean,
): Promise<NamedPath> {
  const folder = await sftp.stat(dir);
  if (fileType(folder.mode) !== 'dir') {
    throw new TermavoxError(ErrorCode.NotFound, 'no such folder');
  }
  const target = { path: joinPath(dir, name), parent: dir, name };
  await replaced(sftp, target.path, overwrite);
  return target;
}

/**
 * The permission bits an upload to `path` keeps: those of the file it replaces when the upload
 * starts, so that its temporary file never has wider ones (plan §5.12). Null when it replaces
 * nothing or a dangling link: the new file gets the bits its request asked for, or else the
 * server's default, like any file creation. CONFLICT as at the commit (a name that appeared
 * without `overwrite`, a folder).
 */
export async function keptMode(
  sftp: SftpSession,
  path: string,
  overwrite: boolean,
): Promise<number | null> {
  return (await replaced(sftp, path, overwrite))?.mode ?? null;
}

/**
 * Puts a finished upload in place, checking the target again. Replacing is atomic where the server
 * offers `posix-rename@openssh.com`; elsewhere the old file is removed first. A new name never
 * replaces anything (CONFLICT if one appeared). The permission bits were set on the open handle
 * (keptMode): nothing here changes a permission by path, which a link swapped in would redirect.
 * The rename itself goes by path: what lies under the temporary name then is what gets the name.
 */
export async function commitUpload(
  sftp: SftpSession,
  tempPath: string,
  target: NamedPath,
  overwrite: boolean,
): Promise<void> {
  const old = await replaced(sftp, target.path, overwrite);
  if (old) {
    if (sftp.supportsPosixRename) {
      await sftp.posixRename(tempPath, target.path);
      return;
    }
    await sftp.unlink(target.path);
    try {
      await sftp.rename(tempPath, target.path);
    } catch (err) {
      throw new TermavoxError(
        ErrorCode.FileOpFailed,
        `the old file was removed but the upload could not take its place; it is kept as ${tempPath.slice(tempPath.lastIndexOf('/') + 1)}`,
        { keepTemp: true, cause: sftpStatus(err) },
      );
    }
    return;
  }
  try {
    await sftp.rename(tempPath, target.path);
  } catch (err) {
    // OpenSSH refuses an existing target with a generic FAILURE: one appeared meanwhile.
    if (sftpStatus(err) === SftpStatus.Failure && (await lstatOrNull(sftp, target.path))) {
      throw conflict();
    }
    throw err;
  }
}

/** The attributes of a file that may be downloaded (links followed); NOT_FOUND for anything else. */
export async function downloadable(sftp: SftpSession, path: string): Promise<SftpAttrs> {
  const attrs = await sftp.stat(path);
  if (fileType(attrs.mode) !== 'file') throw new TermavoxError(ErrorCode.NotFound, 'not a file');
  return attrs;
}

/** What uploading to `path` would replace: null when nothing has that name. */
async function replaced(
  sftp: SftpSession,
  path: string,
  overwrite: boolean,
): Promise<Replaced | null> {
  const own = await lstatOrNull(sftp, path);
  if (!own) return null;
  if (!overwrite) throw conflict();
  let resolved: SftpAttrs | null = own;
  if (fileType(own.mode) === 'link') {
    resolved = await sftp.stat(path).catch((err: unknown) => {
      if (sftpStatus(err) === SftpStatus.NoSuchFile) return null; // dangling: no mode to keep
      throw err;
    });
  }
  if (resolved && fileType(resolved.mode) === 'dir') {
    throw new TermavoxError(ErrorCode.Conflict, 'a folder has this name');
  }
  return { mode: resolved ? resolved.mode & 0o7777 : null };
}

function conflict(): TermavoxError {
  return new TermavoxError(ErrorCode.Conflict, 'a file or folder with this name already exists');
}
