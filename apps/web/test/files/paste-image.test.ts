import { FILES_LIMITS, type FileEntry } from '@termavox/protocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { SessionFiles } from '../../lib/files/client.ts';
import { FileCode, FileRequestError, isFileRequestError } from '../../lib/files/errors.ts';
import {
  PASTE_DIR,
  PASTE_KEEP_MS,
  pasteFolder,
  pasteImageName,
  prunePastes,
  savePastedImage,
} from '../../lib/files/paste-image.ts';
import type {
  TransferJob,
  TransferJobState,
  TransferQueue,
  UploadInput,
} from '../../lib/files/transfer-queue.ts';

const HOME = '/home/tv';
const DIR = '/home/tv/.cache/termavox/paste';
const NOW = new Date(2026, 9, 21, 4, 5, 6);

/** Lets pending promise chains (and the timers they wait on) run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const entry = (name: string, mtime: number, type: FileEntry['type'] = 'file'): FileEntry => ({
  name,
  type,
  size: 10,
  mtime,
  mode: 0o644,
});

/** The session's file operations, answered at once; `mkdirError`/`listError`/`removeError` fail them. */
function fakeFiles(
  options: {
    home?: string;
    entries?: FileEntry[];
    mkdirError?: (path: string) => unknown;
    listError?: unknown;
    removeError?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const files = {
    open: vi.fn(async () => {
      calls.push('open');
      return { op: 'open' as const, home: options.home ?? HOME, cwd: null };
    }),
    mkdir: vi.fn(async (path: string) => {
      calls.push(`mkdir ${path}`);
      const error = options.mkdirError?.(path);
      if (error) throw error;
      return { op: 'mkdir' as const, entry: entry(path.split('/').pop()!, 0, 'dir') };
    }),
    list: vi.fn(async (path: string) => {
      calls.push(`list ${path}`);
      if (options.listError) throw options.listError;
      return { op: 'list' as const, path, entries: options.entries ?? [], truncated: false };
    }),
    remove: vi.fn(async (paths: string[]) => {
      calls.push(`remove ${paths.length}`);
      if (options.removeError) throw options.removeError;
      return { op: 'remove' as const, removed: paths.length };
    }),
  } satisfies Pick<SessionFiles, 'open' | 'mkdir' | 'list' | 'remove'>;
  return { files, calls };
}

function job(id: string, state: TransferJobState, error: TransferJob['error'] = null): TransferJob {
  return {
    id,
    sessionId: 's1',
    direction: 'upload',
    name: 'paste.png',
    dir: DIR,
    size: 3,
    bytes: 3,
    state,
    error,
    speed: null,
    untracked: false,
    overwrite: false,
    finishedAt: 1,
  };
}

/** The tab's transfer queue as savePastedImage sees it: the test settles the jobs. */
class FakeQueue implements Pick<TransferQueue, 'enqueueUploads' | 'onSettled'> {
  readonly enqueued: Array<{ sessionId: string; dir: string; uploads: readonly UploadInput[] }> =
    [];
  readonly listeners = new Set<(job: TransferJob) => void>();
  /** What enqueueUploads returns. */
  ids: string[] = ['u1'];
  /** Runs inside enqueueUploads, before it returns (a job that settles at once). */
  during: ((ids: string[]) => void) | null = null;

  enqueueUploads(sessionId: string, dir: string, uploads: readonly UploadInput[]): string[] {
    this.enqueued.push({ sessionId, dir, uploads });
    this.during?.(this.ids);
    return this.ids;
  }

  onSettled(listener: (job: TransferJob) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  settle(settled: TransferJob): void {
    for (const listener of [...this.listeners]) listener(settled);
  }
}

const pngImage = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e])], { type: 'image/png' });

/** Starts a save and waits until its upload is in the queue (wrapped, so it is not awaited). */
async function startSave(queue: FakeQueue, files = fakeFiles().files, image = pngImage()) {
  const saving = savePastedImage({
    files,
    queue,
    sessionId: 's1',
    image,
    extension: 'png',
    now: NOW,
  });
  await flush();
  return { saving };
}

/** The error a promise rejects with (fails the test if it resolves). */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, resolved with ${String(value)}`);
    },
    (error: unknown) => error,
  );
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  const first = await Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    flush().then(() => pending),
  ]);
  return first === pending;
}

describe('pasted image names (plan D-48)', () => {
  it('names a paste by its local date and time, zero padded, then the suffix', () => {
    expect(pasteImageName('png', new Date(2026, 9, 21, 4, 5, 6), 'a1b2')).toBe(
      'paste-20261021-040506-a1b2.png',
    );
    expect(pasteImageName('jpg', new Date(2026, 0, 2, 13, 0, 9), 'ffff')).toBe(
      'paste-20260102-130009-ffff.jpg',
    );
    expect(pasteImageName('webp', new Date(2026, 11, 31, 23, 59, 59), '0000')).toBe(
      'paste-20261231-235959-0000.webp',
    );
  });
});

describe('the paste folder (plan D-48)', () => {
  it('is .cache/termavox/paste under the home, created one level at a time', async () => {
    expect(PASTE_DIR).toEqual(['.cache', 'termavox', 'paste']);
    const { files, calls } = fakeFiles();
    await expect(pasteFolder(files)).resolves.toBe(DIR);
    expect(files.open).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      'open',
      'mkdir /home/tv/.cache',
      'mkdir /home/tv/.cache/termavox',
      'mkdir /home/tv/.cache/termavox/paste',
    ]);
  });

  it('joins the home without doubling slashes (root, trailing slash)', async () => {
    await expect(pasteFolder(fakeFiles({ home: '/' }).files)).resolves.toBe(
      '/.cache/termavox/paste',
    );
    await expect(pasteFolder(fakeFiles({ home: '/root/' }).files)).resolves.toBe(
      '/root/.cache/termavox/paste',
    );
  });

  it('takes folders that already exist (CONFLICT) as created', async () => {
    const { files, calls } = fakeFiles({
      mkdirError: () => new FileRequestError(FileCode.Conflict),
    });
    await expect(pasteFolder(files)).resolves.toBe(DIR);
    expect(files.mkdir).toHaveBeenCalledTimes(3);
    expect(calls.at(-1)).toBe(`mkdir ${DIR}`);
  });

  it('rejects with any other mkdir failure as it came, and stops there', async () => {
    const denied = new FileRequestError(FileCode.PermissionDenied, 'denied');
    const { files, calls } = fakeFiles({
      mkdirError: (path) => (path.endsWith('/termavox') ? denied : null),
    });
    await expect(pasteFolder(files)).rejects.toBe(denied);
    expect(calls).toEqual(['open', 'mkdir /home/tv/.cache', 'mkdir /home/tv/.cache/termavox']);

    // Only a FileRequestError's CONFLICT code counts as "exists", not an error that reads like it.
    const plain = new Error(FileCode.Conflict);
    await expect(pasteFolder(fakeFiles({ mkdirError: () => plain }).files)).rejects.toBe(plain);
  });
});

describe('pruning old pastes (plan D-48)', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  const old = now - PASTE_KEEP_MS - 1;

  it('keeps pastes for a week', () => {
    expect(PASTE_KEEP_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('removes only files named paste-… older than PASTE_KEEP_MS', async () => {
    const { files } = fakeFiles({
      entries: [
        entry('paste-old.png', old),
        entry('paste-boundary.png', now - PASTE_KEEP_MS),
        entry('paste-new.png', now - 1000),
        entry('paste-folder', old, 'dir'),
        entry('paste-link.png', old, 'link'),
        entry('paste-other', old, 'other'),
        entry('notes.txt', old),
        entry('my-paste-old.png', old),
        entry('paste-older.jpg', 0),
      ],
    });
    await expect(prunePastes(files, DIR, now)).resolves.toBeUndefined();
    expect(files.list).toHaveBeenCalledExactlyOnceWith(DIR);
    expect(files.remove).toHaveBeenCalledExactlyOnceWith([
      `${DIR}/paste-old.png`,
      `${DIR}/paste-older.jpg`,
    ]);
  });

  it('never calls remove when nothing qualifies', async () => {
    const empty = fakeFiles();
    await prunePastes(empty.files, DIR, now);
    expect(empty.files.list).toHaveBeenCalledOnce();
    expect(empty.files.remove).not.toHaveBeenCalled();

    const recent = fakeFiles({
      entries: [entry('paste-a.png', now - PASTE_KEEP_MS), entry('readme', old)],
    });
    await prunePastes(recent.files, DIR, now);
    expect(recent.files.remove).not.toHaveBeenCalled();
  });

  it('removes at most FILES_LIMITS.removePaths at a time, the first ones listed', async () => {
    const count = FILES_LIMITS.removePaths + 5;
    const entries = Array.from({ length: count }, (_, i) => entry(`paste-${i}.png`, old));
    const { files } = fakeFiles({ entries });
    await prunePastes(files, DIR, now);
    expect(files.remove).toHaveBeenCalledOnce();
    const paths = files.remove.mock.calls[0]![0];
    expect(paths).toHaveLength(FILES_LIMITS.removePaths);
    expect(paths[0]).toBe(`${DIR}/paste-0.png`);
    expect(paths.at(-1)).toBe(`${DIR}/paste-${FILES_LIMITS.removePaths - 1}.png`);
  });

  it('swallows list and remove failures (the next paste tries again)', async () => {
    const listFails = fakeFiles({ listError: new FileRequestError(FileCode.SftpUnavailable) });
    await expect(prunePastes(listFails.files, DIR, now)).resolves.toBeUndefined();
    expect(listFails.files.remove).not.toHaveBeenCalled();

    const removeFails = fakeFiles({
      entries: [entry('paste-old.png', old)],
      removeError: new FileRequestError(FileCode.PermissionDenied),
    });
    await expect(prunePastes(removeFails.files, DIR, now)).resolves.toBeUndefined();
    expect(removeFails.files.remove).toHaveBeenCalledOnce();
  });
});

describe('saving a pasted image (plan D-48)', () => {
  it('uploads it once into the paste folder and resolves with its absolute path', async () => {
    const queue = new FakeQueue();
    const { files } = fakeFiles();
    const image = pngImage();
    const { saving } = await startSave(queue, files, image);

    expect(queue.enqueued).toHaveLength(1);
    const [upload] = queue.enqueued;
    expect(upload!.sessionId).toBe('s1');
    expect(upload!.dir).toBe(DIR);
    expect(upload!.uploads).toEqual([
      {
        name: expect.stringMatching(/^paste-\d{8}-\d{6}-[0-9a-f]{4}\.png$/),
        size: image.size,
        overwrite: false,
        body: image,
      },
    ]);
    const { name, body } = upload!.uploads[0]!;
    expect(name).toMatch(/^paste-20261021-040506-[0-9a-f]{4}\.png$/);
    expect(body).toBe(image);
    // The old pastes are pruned only once the upload succeeded.
    expect(files.list).not.toHaveBeenCalled();

    queue.settle(job('u1', 'done'));
    await expect(saving).resolves.toBe(`${DIR}/${name}`);
    expect(queue.listeners.size).toBe(0);
  });

  it('prunes the folder after a successful upload', async () => {
    const queue = new FakeQueue();
    const now = NOW.getTime();
    const { files } = fakeFiles({
      entries: [entry('paste-old.png', now - PASTE_KEEP_MS - 1), entry('paste-new.png', now)],
    });
    const { saving } = await startSave(queue, files);
    queue.settle(job('u1', 'done'));
    await saving;
    expect(files.list).toHaveBeenCalledExactlyOnceWith(DIR);
    await flush();
    expect(files.remove).toHaveBeenCalledExactlyOnceWith([`${DIR}/paste-old.png`]);
  });

  it('waits for its own job: other settled jobs are ignored', async () => {
    const queue = new FakeQueue();
    const { saving } = await startSave(queue);
    queue.settle(job('other', 'done'));
    queue.settle(job('another', 'failed', { code: FileCode.PermissionDenied, message: 'no' }));
    expect(await isPending(saving)).toBe(true);
    expect(queue.listeners.size).toBe(1);

    queue.settle(job('u1', 'done'));
    await expect(saving).resolves.toMatch(/^\/home\/tv\/\.cache\/termavox\/paste\/paste-/);
  });

  it('rejects with the job error code when the upload fails', async () => {
    const queue = new FakeQueue();
    const { files } = fakeFiles();
    const { saving } = await startSave(queue, files);
    const outcome = rejection(saving);
    queue.settle(job('u1', 'failed', { code: FileCode.PermissionDenied, message: 'denied' }));
    const error = await outcome;
    expect(isFileRequestError(error)).toBe(true);
    expect((error as FileRequestError).code).toBe(FileCode.PermissionDenied);
    expect((error as FileRequestError).message).toBe('denied');
    expect(queue.listeners.size).toBe(0);
    expect(files.list).not.toHaveBeenCalled();
  });

  it('rejects with CANCELLED when the job is cancelled without an error', async () => {
    const queue = new FakeQueue();
    const { saving } = await startSave(queue);
    const outcome = rejection(saving);
    queue.settle(job('u1', 'cancelled'));
    const error = await outcome;
    expect(isFileRequestError(error)).toBe(true);
    expect((error as FileRequestError).code).toBe(FileCode.Cancelled);
    expect(queue.listeners.size).toBe(0);
  });

  it('handles a job that settles before enqueueUploads returns its id', async () => {
    const done = new FakeQueue();
    done.during = (ids) => {
      done.settle(job('other', 'failed', { code: FileCode.Internal, message: 'x' }));
      done.settle(job(ids[0]!, 'done'));
    };
    const name = savePastedImage({
      files: fakeFiles().files,
      queue: done,
      sessionId: 's1',
      image: pngImage(),
      extension: 'png',
      now: NOW,
    });
    await expect(name).resolves.toMatch(/^\/home\/tv\/\.cache\/termavox\/paste\/paste-.*\.png$/);
    expect(done.listeners.size).toBe(0);

    const failed = new FakeQueue();
    failed.during = (ids) => {
      failed.settle(job(ids[0]!, 'failed', { code: FileCode.Conflict, message: 'exists' }));
    };
    const error = await rejection(
      savePastedImage({
        files: fakeFiles().files,
        queue: failed,
        sessionId: 's1',
        image: pngImage(),
        extension: 'png',
        now: NOW,
      }),
    );
    expect(isFileRequestError(error)).toBe(true);
    expect((error as FileRequestError).code).toBe(FileCode.Conflict);
    expect(failed.listeners.size).toBe(0);
  });

  it('rejects with INTERNAL when the queue takes no job', async () => {
    const queue = new FakeQueue();
    queue.ids = [];
    const { files } = fakeFiles();
    const error = await rejection(
      savePastedImage({ files, queue, sessionId: 's1', image: pngImage(), extension: 'png' }),
    );
    expect(isFileRequestError(error)).toBe(true);
    expect((error as FileRequestError).code).toBe(FileCode.Internal);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.listeners.size).toBe(0);
    expect(files.list).not.toHaveBeenCalled();
  });

  it('rejects with the folder failure and uploads nothing', async () => {
    const denied = new FileRequestError(FileCode.PermissionDenied);
    const queue = new FakeQueue();
    const { files } = fakeFiles({ mkdirError: () => denied });
    const error = await rejection(
      savePastedImage({ files, queue, sessionId: 's1', image: pngImage(), extension: 'png' }),
    );
    expect(error).toBe(denied);
    expect(queue.enqueued).toHaveLength(0);
    expect(queue.listeners.size).toBe(0);
  });
});
