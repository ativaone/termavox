import { FILES_LIMITS } from '@termavox/protocol/client';
import { type PasteTarget, pastablePath, pasteText } from '../terminal/paste.ts';
import type { SessionFiles } from './client.ts';
import { FileCode, FileRequestError, isFileRequestError } from './errors.ts';
import { joinPath } from './paths.ts';
import type { TransferJob, TransferQueue } from './transfer-queue.ts';

/**
 * Images pasted into a terminal (plan D-48): the browser sends them to the session's server
 * with the file panel's upload, into a folder under the user's home that only the user can read
 * or change, and the terminal gets the file's path, so a program there (Claude Code, an editor)
 * can open it. Termavox runs nothing on the server in between, so old pastes are removed from
 * that folder when a new one is saved. Framework-free.
 */

/** The folder, under the user's home. */
export const PASTE_DIR = ['.cache', 'termavox', 'paste'] as const;
/** The bits of each folder a paste creates (a folder that exists keeps its own). */
export const PASTE_DIR_MODE = 0o700;
/** The bits of a saved image: only the user can read it. */
export const PASTE_FILE_MODE = 0o600;
/** Pastes older than this, next to a new one, are removed when it is saved. */
export const PASTE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The largest image a paste sends: 32 MiB. */
export const PASTE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
/** The names pasteImageName gives: the only entries a prune removes. */
export const PASTE_NAME = /^paste-\d{8}-\d{6}-[0-9a-f]{4}\.(png|jpg|gif|webp)$/;
/** Write bits for the group and others: with them, someone else can swap what the folder holds. */
const SHARED_WRITE = 0o022;
const PREFIX = 'paste-';

const pad = (value: number): string => String(value).padStart(2, '0');

/** `paste-20261021-143212-a1b2.png`: sorts by time; the suffix keeps two pastes apart. */
export function pasteImageName(extension: string, now: Date, suffix: string): string {
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${PREFIX}${day}-${time}-${suffix}.${extension}`;
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The paste folder, or one above it, is not a folder only its user can change: a link, not a
 * folder, or writable by the group or others. `path` is that folder (links above it resolved).
 */
export class UnsafePasteFolderError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`the paste folder ${path} can be changed by other users`);
    this.name = 'UnsafePasteFolderError';
    this.path = path;
  }
}

/** Recognizes an UnsafePasteFolderError from any copy of this module (name and path). */
export function isUnsafePasteFolderError(err: unknown): err is UnsafePasteFolderError {
  return (
    err instanceof UnsafePasteFolderError ||
    (err instanceof Error &&
      err.name === 'UnsafePasteFolderError' &&
      typeof (err as { path?: unknown }).path === 'string')
  );
}

/**
 * Creates the folder where needed, each new level with PASTE_DIR_MODE (one that exists keeps its
 * bits: there is no chmod), then checks, in their parents' listings (lstat: a link is a link),
 * that `termavox` and `paste` are folders that neither the group nor others can write: otherwise
 * UnsafePasteFolderError, and nothing is uploaded. Resolves with the paste folder's canonical path
 * (links resolved), where the image and the prune go.
 */
export async function pasteFolder(
  files: Pick<SessionFiles, 'open' | 'mkdir' | 'list'>,
): Promise<string> {
  const { home } = await files.open();
  const levels: string[] = [];
  let dir = home;
  for (const part of PASTE_DIR) {
    dir = joinPath(dir, part);
    levels.push(dir);
    try {
      await files.mkdir(dir, PASTE_DIR_MODE);
    } catch (err) {
      if (!(isFileRequestError(err) && err.code === FileCode.Conflict)) throw err;
    }
  }
  const [cache, termavox] = levels as [string, string, string];
  await checkOwnFolder(files, cache, PASTE_DIR[1]);
  await checkOwnFolder(files, termavox, PASTE_DIR[2]);
  return (await files.list(dir)).path;
}

/** `name` in `parent`'s listing must be a folder without write bits for the group or others. */
async function checkOwnFolder(
  files: Pick<SessionFiles, 'list'>,
  parent: string,
  name: string,
): Promise<void> {
  const listing = await files.list(parent);
  const entry = listing.entries.find((e) => e.name === name);
  if (!entry) {
    // Created or found a moment ago, yet not listed (a listing cut short): nothing to check.
    throw new FileRequestError(FileCode.FileOpFailed, `${name} is missing from its folder`);
  }
  if (entry.type !== 'dir' || (entry.mode & SHARED_WRITE) !== 0) {
    throw new UnsafePasteFolderError(joinPath(listing.path, name));
  }
}

/**
 * Removes the folder's pastes (regular files named like PASTE_NAME) older than PASTE_KEEP_MS,
 * measured against the modification time of `saved`, the paste just saved, in the same listing:
 * the server's clock, never the browser's. Without `saved` in that listing, nothing is removed.
 * The request removes files only: whatever is no longer a regular file when the server gets to
 * it is skipped. A failure waits for the next paste.
 */
export async function prunePastes(
  files: Pick<SessionFiles, 'list' | 'remove'>,
  dir: string,
  saved: string,
): Promise<void> {
  try {
    const { entries } = await files.list(dir);
    const own = entries.find((e) => e.name === saved && e.type === 'file');
    if (!own) return;
    const old = entries
      .filter(
        (e) => e.type === 'file' && PASTE_NAME.test(e.name) && own.mtime - e.mtime > PASTE_KEEP_MS,
      )
      .map((e) => joinPath(dir, e.name))
      .slice(0, FILES_LIMITS.removePaths);
    if (old.length > 0) await files.remove(old, { filesOnly: true });
  } catch {
    // Left for the next paste.
  }
}

/**
 * Saves a pasted image on the session's server through the tab's transfer queue (it shows in
 * the file panel's transfers like any upload), readable by the user only (PASTE_FILE_MODE), and
 * resolves with its absolute path. Rejects with an UnsafePasteFolderError, or a FileRequestError
 * when the folder or the upload fails.
 */
export async function savePastedImage(options: {
  files: Pick<SessionFiles, 'open' | 'mkdir' | 'list' | 'remove'>;
  queue: Pick<TransferQueue, 'enqueueUploads' | 'onSettled'>;
  sessionId: string;
  image: Blob;
  extension: string;
  now?: Date;
}): Promise<string> {
  const { files, queue, sessionId, image, extension } = options;
  const now = options.now ?? new Date();
  const dir = await pasteFolder(files);
  const name = pasteImageName(extension, now, randomSuffix());
  const path = joinPath(dir, name);
  await new Promise<void>((resolve, reject) => {
    let id: string | null = null;
    const settled: TransferJob[] = [];
    const finish = (job: TransferJob) => {
      off();
      if (job.state === 'done') resolve();
      else {
        const code = job.error?.code ?? FileCode.Cancelled;
        reject(new FileRequestError(code, job.error?.message ?? code));
      }
    };
    const off = queue.onSettled((job) => {
      if (id === null) settled.push(job);
      else if (job.id === id) finish(job);
    });
    id =
      queue.enqueueUploads(sessionId, dir, [
        { name, size: image.size, overwrite: false, body: image, mode: PASTE_FILE_MODE },
      ])[0] ?? null;
    if (id === null) {
      off();
      reject(new FileRequestError(FileCode.Internal));
      return;
    }
    const early = settled.find((job) => job.id === id);
    if (early) finish(early);
  });
  void prunePastes(files, dir, name);
  return path;
}

/** What a pane shows: its session, and its terminal (null once gone). */
export interface PasteView {
  sessionId: string;
  terminal: PasteTarget | null;
}

/** What an image paste tells its pane: a message key under `workspace.pane`, with its values. */
export type ImagePasteNotice =
  | { key: 'imagePasteUnavailable' }
  | { key: 'imagePasteTooLarge' }
  | { key: 'imagePasteUnsafeFolder'; path: string }
  | { key: 'imagePasteNotPasted'; path: string }
  | { key: 'imagePasteBadPath' }
  | { key: 'imagePasteFailed'; error: unknown };

/**
 * One image pasted into a pane (plan D-48). While one of the pane's image pastes runs (`busy`),
 * another is dropped without a word. Otherwise: file transfer must be allowed for the session,
 * the image at most PASTE_IMAGE_MAX_BYTES; `save` stores it on the server of the session the pane
 * shows, and its path is typed only if the pane still shows that session in the same terminal,
 * and only in its pastablePath form. Every other outcome is a notice. Never rejects.
 */
export async function pasteImage(options: {
  image: Blob;
  extension: string;
  /** File transfer is allowed for the pane's session. */
  allowed: boolean;
  /** The pane's flag, true while one of its image pastes runs. */
  busy: { current: boolean };
  /** What the pane shows now. */
  view: () => PasteView;
  save: (image: Blob, extension: string, sessionId: string) => Promise<string>;
  notice: (notice: ImagePasteNotice) => void;
}): Promise<void> {
  const { image, extension, busy, view, save, notice } = options;
  if (busy.current) return;
  if (!options.allowed) {
    notice({ key: 'imagePasteUnavailable' });
    return;
  }
  if (image.size > PASTE_IMAGE_MAX_BYTES) {
    notice({ key: 'imagePasteTooLarge' });
    return;
  }
  busy.current = true;
  const from = view();
  try {
    const path = await save(image, extension, from.sessionId);
    const to = view();
    if (!to.terminal || to.terminal !== from.terminal || to.sessionId !== from.sessionId) {
      notice({ key: 'imagePasteNotPasted', path });
      return;
    }
    const text = pastablePath(path);
    if (text === null) notice({ key: 'imagePasteBadPath' });
    else pasteText(to.terminal, text);
  } catch (err) {
    notice(
      isUnsafePasteFolderError(err)
        ? { key: 'imagePasteUnsafeFolder', path: err.path }
        : { key: 'imagePasteFailed', error: err },
    );
  } finally {
    busy.current = false;
  }
}
