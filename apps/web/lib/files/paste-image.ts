import { FILES_LIMITS } from '@termavox/protocol/client';
import type { SessionFiles } from './client.ts';
import { FileCode, FileRequestError, isFileRequestError } from './errors.ts';
import { joinPath } from './paths.ts';
import type { TransferJob, TransferQueue } from './transfer-queue.ts';

/**
 * Images pasted into a terminal (plan D-48): the browser sends them to the session's server
 * with the file panel's upload, into a folder under the user's home, and the terminal gets the
 * file's path, so a program there (Claude Code, an editor) can open it. Termavox runs nothing on
 * the server in between, so old pastes are removed from that folder when a new one is saved.
 * Framework-free.
 */

/** The folder, under the user's home. */
export const PASTE_DIR = ['.cache', 'termavox', 'paste'] as const;
/** Pastes older than this are removed when a new one is saved. */
export const PASTE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
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

/** Creates the folder where needed (existing ones are fine) and returns its absolute path. */
export async function pasteFolder(files: Pick<SessionFiles, 'open' | 'mkdir'>): Promise<string> {
  const { home } = await files.open();
  let dir = home;
  for (const part of PASTE_DIR) {
    dir = joinPath(dir, part);
    try {
      await files.mkdir(dir);
    } catch (err) {
      if (!(isFileRequestError(err) && err.code === FileCode.Conflict)) throw err;
    }
  }
  return dir;
}

/** Removes the folder's pastes older than PASTE_KEEP_MS; a failure waits for the next paste. */
export async function prunePastes(
  files: Pick<SessionFiles, 'list' | 'remove'>,
  dir: string,
  now: number,
): Promise<void> {
  try {
    const { entries } = await files.list(dir);
    const old = entries
      .filter(
        (e) => e.type === 'file' && e.name.startsWith(PREFIX) && now - e.mtime > PASTE_KEEP_MS,
      )
      .map((e) => joinPath(dir, e.name))
      .slice(0, FILES_LIMITS.removePaths);
    if (old.length > 0) await files.remove(old);
  } catch {
    // Left for the next paste.
  }
}

/**
 * Saves a pasted image on the session's server through the tab's transfer queue (it shows in
 * the file panel's transfers like any upload) and resolves with its absolute path. Rejects with
 * a FileRequestError when the folder or the upload fails.
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
        { name, size: image.size, overwrite: false, body: image },
      ])[0] ?? null;
    if (id === null) {
      off();
      reject(new FileRequestError(FileCode.Internal));
      return;
    }
    const early = settled.find((job) => job.id === id);
    if (early) finish(early);
  });
  void prunePastes(files, dir, now.getTime());
  return path;
}
