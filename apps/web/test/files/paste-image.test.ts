import { FILES_LIMITS, type FileEntry } from '@termavox/protocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { RemoveOptions, SessionFiles } from '../../lib/files/client.ts';
import { FileCode, FileRequestError, isFileRequestError } from '../../lib/files/errors.ts';
import {
  type ImagePasteNotice,
  isUnsafePasteFolderError,
  PASTE_DIR,
  PASTE_DIR_MODE,
  PASTE_FILE_MODE,
  PASTE_IMAGE_MAX_BYTES,
  PASTE_KEEP_MS,
  PASTE_NAME,
  type PasteView,
  pasteFolder,
  pasteImage,
  pasteImageName,
  prunePastes,
  savePastedImage,
  UnsafePasteFolderError,
} from '../../lib/files/paste-image.ts';
import type {
  TransferJob,
  TransferJobState,
  TransferQueue,
  UploadInput,
} from '../../lib/files/transfer-queue.ts';

const HOME = '/home/tv';
const CACHE = '/home/tv/.cache';
const TERMAVOX = '/home/tv/.cache/termavox';
const DIR = '/home/tv/.cache/termavox/paste';
const NOW = new Date(2026, 9, 21, 4, 5, 6);

/** Lets pending promise chains (and the timers they wait on) run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const entry = (
  name: string,
  mtime: number,
  type: FileEntry['type'] = 'file',
  mode = type === 'dir' ? 0o700 : 0o600,
): FileEntry => ({ name, type, size: 10, mtime, mode });

type Listing = { path?: string; entries: FileEntry[] };

/**
 * The session's file operations, answered at once. `.cache` lists `termavox` and `termavox` lists
 * `paste` (folders of the user's alone) unless `listings` says otherwise; any other folder lists
 * `entries` (a live array: a test may add to it). The `…Error` options fail those requests.
 */
function fakeFiles(
  options: {
    home?: string;
    entries?: FileEntry[];
    listings?: Record<string, Listing>;
    mkdirError?: (path: string) => unknown;
    listError?: unknown;
    removeError?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const entries = options.entries ?? [];
  const listingOf = (path: string): Listing => {
    const set = options.listings?.[path];
    if (set) return set;
    if (path.endsWith('/.cache')) return { entries: [entry('termavox', 0, 'dir')] };
    if (path.endsWith('/termavox')) return { entries: [entry('paste', 0, 'dir')] };
    return { entries };
  };
  const files = {
    open: vi.fn(async () => {
      calls.push('open');
      return { op: 'open' as const, home: options.home ?? HOME, cwd: null };
    }),
    mkdir: vi.fn(async (path: string, mode?: number) => {
      calls.push(`mkdir ${path} ${mode?.toString(8)}`);
      const error = options.mkdirError?.(path);
      if (error) throw error;
      return { op: 'mkdir' as const, entry: entry(path.split('/').pop()!, 0, 'dir') };
    }),
    list: vi.fn(async (path: string) => {
      calls.push(`list ${path}`);
      if (options.listError) throw options.listError;
      const listing = listingOf(path);
      return {
        op: 'list' as const,
        path: listing.path ?? path,
        entries: listing.entries,
        truncated: false,
      };
    }),
    remove: vi.fn(async (paths: string[], removeOptions?: RemoveOptions) => {
      calls.push(`remove ${paths.length}${removeOptions?.filesOnly ? ' files' : ''}`);
      if (options.removeError) throw options.removeError;
      return { op: 'remove' as const, removed: paths.length };
    }),
  } satisfies Pick<SessionFiles, 'open' | 'mkdir' | 'list' | 'remove'>;
  return { files, calls, entries };
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

/** A name pasteImageName gives, with a counter in its suffix. */
const pasteName = (i: number, extension = 'png') =>
  `paste-20261001-000000-${i.toString(16).padStart(4, '0')}.${extension}`;

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

  it('gives exactly the names a prune may remove', () => {
    for (const extension of ['png', 'jpg', 'gif', 'webp']) {
      expect(PASTE_NAME.test(pasteImageName(extension, NOW, '09af'))).toBe(true);
    }
    for (const other of [
      'paste-old.png',
      'paste-20261001-000000-ABCD.png',
      'paste-20261001-000000-0a1.png',
      'paste-20261001-000000-0a1b.bmp',
      'paste-20261001-000000-0a1b.png.sh',
      'xpaste-20261001-000000-0a1b.png',
      'paste-2026101-000000-0a1b.png',
      'paste-20261001-000000-0a1b.png\n',
    ]) {
      expect(PASTE_NAME.test(other), other).toBe(false);
    }
  });
});

describe('the paste folder (plan D-48)', () => {
  it('is .cache/termavox/paste under the home: created 0700 level by level, then checked', async () => {
    expect(PASTE_DIR).toEqual(['.cache', 'termavox', 'paste']);
    expect(PASTE_DIR_MODE).toBe(0o700);
    const { files, calls } = fakeFiles();
    await expect(pasteFolder(files)).resolves.toBe(DIR);
    expect(files.open).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      'open',
      `mkdir ${CACHE} 700`,
      `mkdir ${TERMAVOX} 700`,
      `mkdir ${DIR} 700`,
      // termavox as its parent lists it, then paste, then the folder itself (canonical path).
      `list ${CACHE}`,
      `list ${TERMAVOX}`,
      `list ${DIR}`,
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

  it('takes folders that already exist (CONFLICT) as they are: no chmod', async () => {
    const { files, calls } = fakeFiles({
      mkdirError: () => new FileRequestError(FileCode.Conflict),
      listings: {
        [CACHE]: { entries: [entry('termavox', 0, 'dir', 0o755)] },
        [TERMAVOX]: { entries: [entry('paste', 0, 'dir', 0o750)] },
      },
    });
    await expect(pasteFolder(files)).resolves.toBe(DIR);
    // Their bits stay as they are (0755 and 0750 pass: no write for the group or others).
    expect(calls).toEqual([
      'open',
      `mkdir ${CACHE} 700`,
      `mkdir ${TERMAVOX} 700`,
      `mkdir ${DIR} 700`,
      `list ${CACHE}`,
      `list ${TERMAVOX}`,
      `list ${DIR}`,
    ]);
  });

  it('resolves with the canonical path the folder lists under (links above it resolved)', async () => {
    const { files } = fakeFiles({ listings: { [DIR]: { path: '/srv/tv/paste', entries: [] } } });
    await expect(pasteFolder(files)).resolves.toBe('/srv/tv/paste');
  });

  it('refuses termavox or paste as a link, a file, or writable by the group or others', async () => {
    const unsafe: Array<[string, FileEntry, string]> = [
      [CACHE, entry('termavox', 0, 'link', 0o777), `${CACHE}/termavox`],
      [CACHE, entry('termavox', 0, 'file'), `${CACHE}/termavox`],
      [CACHE, entry('termavox', 0, 'dir', 0o770), `${CACHE}/termavox`],
      [CACHE, entry('termavox', 0, 'dir', 0o1777), `${CACHE}/termavox`],
      [TERMAVOX, entry('paste', 0, 'link', 0o777), `${TERMAVOX}/paste`],
      [TERMAVOX, entry('paste', 0, 'other'), `${TERMAVOX}/paste`],
      [TERMAVOX, entry('paste', 0, 'dir', 0o702), `${TERMAVOX}/paste`],
      [TERMAVOX, entry('paste', 0, 'dir', 0o720), `${TERMAVOX}/paste`],
    ];
    for (const [parent, listed, path] of unsafe) {
      const { files, calls } = fakeFiles({ listings: { [parent]: { entries: [listed] } } });
      const error = await rejection(pasteFolder(files));
      expect(isUnsafePasteFolderError(error), path).toBe(true);
      expect((error as UnsafePasteFolderError).path).toBe(path);
      // Nothing past the folder that failed its check.
      expect(calls.at(-1)).toBe(`list ${parent}`);
    }
  });

  it('names the unsafe folder by its canonical path', async () => {
    const { files } = fakeFiles({
      listings: { [CACHE]: { path: '/data/cache', entries: [entry('termavox', 0, 'dir', 0o777)] } },
    });
    const error = await rejection(pasteFolder(files));
    expect(error).toBeInstanceOf(UnsafePasteFolderError);
    expect((error as UnsafePasteFolderError).path).toBe('/data/cache/termavox');
  });

  it('fails when a level it just made is missing from its parent listing', async () => {
    const { files } = fakeFiles({ listings: { [TERMAVOX]: { entries: [] } } });
    const error = await rejection(pasteFolder(files));
    expect(isUnsafePasteFolderError(error)).toBe(false);
    expect(isFileRequestError(error)).toBe(true);
    expect((error as FileRequestError).code).toBe(FileCode.FileOpFailed);
  });

  it('rejects with any other mkdir failure as it came, and stops there', async () => {
    const denied = new FileRequestError(FileCode.PermissionDenied, 'denied');
    const { files, calls } = fakeFiles({
      mkdirError: (path) => (path.endsWith('/termavox') ? denied : null),
    });
    await expect(pasteFolder(files)).rejects.toBe(denied);
    expect(calls).toEqual(['open', `mkdir ${CACHE} 700`, `mkdir ${TERMAVOX} 700`]);

    // Only a FileRequestError's CONFLICT code counts as "exists", not an error that reads like it.
    const plain = new Error(FileCode.Conflict);
    await expect(pasteFolder(fakeFiles({ mkdirError: () => plain }).files)).rejects.toBe(plain);
  });

  it('recognizes its own refusal by name, as another copy of the module would throw it', () => {
    const copy = Object.assign(new Error('x'), { name: 'UnsafePasteFolderError', path: '/a' });
    expect(isUnsafePasteFolderError(copy)).toBe(true);
    expect(isUnsafePasteFolderError(new Error('UnsafePasteFolderError'))).toBe(false);
    expect(isUnsafePasteFolderError(new FileRequestError(FileCode.Conflict))).toBe(false);
  });
});

describe('pruning old pastes (plan D-48)', () => {
  const saved = 'paste-20261021-120000-abcd.png';
  /** The saved paste's modification time on the server: the browser's clock plays no part. */
  const at = Date.UTC(2020, 0, 1);
  const old = at - PASTE_KEEP_MS - 1;

  it('keeps pastes for a week', () => {
    expect(PASTE_KEEP_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('removes, files only, the generated names older than a week before the saved paste', async () => {
    const { files } = fakeFiles({
      entries: [
        entry(saved, at),
        entry(pasteName(1), old),
        entry(pasteName(2, 'jpg'), at - PASTE_KEEP_MS),
        entry(pasteName(3, 'gif'), at - 1000),
        entry(pasteName(4, 'webp'), 0),
        entry(pasteName(5), old, 'dir'),
        entry(pasteName(6), old, 'link'),
        entry(pasteName(7), old, 'other'),
        entry('notes.txt', old),
        entry('paste-old.png', old),
        entry('paste-20261001-000000-ABCD.png', old),
        entry('paste-20261001-000000-0a1b.png.sh', old),
        entry('my-paste-20261001-000000-0a1b.png', old),
        entry(pasteName(8), at + PASTE_KEEP_MS * 2),
      ],
    });
    await expect(prunePastes(files, DIR, saved)).resolves.toBeUndefined();
    expect(files.list).toHaveBeenCalledExactlyOnceWith(DIR);
    expect(files.remove).toHaveBeenCalledExactlyOnceWith(
      [`${DIR}/${pasteName(1)}`, `${DIR}/${pasteName(4, 'webp')}`],
      { filesOnly: true },
    );
  });

  it('never removes the paste just saved, whatever its own time says', async () => {
    const { files } = fakeFiles({ entries: [entry(saved, 0)] });
    await prunePastes(files, DIR, saved);
    expect(files.remove).not.toHaveBeenCalled();
  });

  it('removes nothing when the saved paste is not in the listing as a file', async () => {
    for (const listed of [[], [entry(saved, at, 'link')], [entry(`${saved}x`, at)]]) {
      const { files } = fakeFiles({ entries: [...listed, entry(pasteName(1), 0)] });
      await prunePastes(files, DIR, saved);
      expect(files.list).toHaveBeenCalledOnce();
      expect(files.remove).not.toHaveBeenCalled();
    }
  });

  it('removes at most FILES_LIMITS.removePaths at a time, the first ones listed', async () => {
    const count = FILES_LIMITS.removePaths + 5;
    const entries = [
      entry(saved, at),
      ...Array.from({ length: count }, (_, i) => entry(pasteName(i), old)),
    ];
    const { files } = fakeFiles({ entries });
    await prunePastes(files, DIR, saved);
    expect(files.remove).toHaveBeenCalledOnce();
    const paths = files.remove.mock.calls[0]![0];
    expect(paths).toHaveLength(FILES_LIMITS.removePaths);
    expect(paths[0]).toBe(`${DIR}/${pasteName(0)}`);
    expect(paths.at(-1)).toBe(`${DIR}/${pasteName(FILES_LIMITS.removePaths - 1)}`);
  });

  it('swallows list and remove failures (the next paste tries again)', async () => {
    const listFails = fakeFiles({ listError: new FileRequestError(FileCode.SftpUnavailable) });
    await expect(prunePastes(listFails.files, DIR, saved)).resolves.toBeUndefined();
    expect(listFails.files.remove).not.toHaveBeenCalled();

    const removeFails = fakeFiles({
      entries: [entry(saved, at), entry(pasteName(1), old)],
      removeError: new FileRequestError(FileCode.PermissionDenied),
    });
    await expect(prunePastes(removeFails.files, DIR, saved)).resolves.toBeUndefined();
    expect(removeFails.files.remove).toHaveBeenCalledOnce();
  });
});

describe('saving a pasted image (plan D-48)', () => {
  it('uploads it once, 0600, into the paste folder and resolves with its absolute path', async () => {
    expect(PASTE_FILE_MODE).toBe(0o600);
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
        name: expect.stringMatching(PASTE_NAME),
        size: image.size,
        overwrite: false,
        body: image,
        mode: 0o600,
      },
    ]);
    const { name, body } = upload!.uploads[0]!;
    expect(name).toMatch(/^paste-20261021-040506-[0-9a-f]{4}\.png$/);
    expect(body).toBe(image);
    // The old pastes are pruned only once the upload succeeded.
    expect(files.list).toHaveBeenCalledTimes(3);

    queue.settle(job('u1', 'done'));
    await expect(saving).resolves.toBe(`${DIR}/${name}`);
    expect(queue.listeners.size).toBe(0);
  });

  it('uploads into, prunes and names the canonical folder', async () => {
    const queue = new FakeQueue();
    const real = '/srv/home/tv/.cache/termavox/paste';
    const entries: FileEntry[] = [entry(pasteName(1), 0)];
    const { files } = fakeFiles({ entries, listings: { [DIR]: { path: real, entries } } });
    const { saving } = await startSave(queue, files);
    expect(queue.enqueued[0]!.dir).toBe(real);
    const { name } = queue.enqueued[0]!.uploads[0]!;
    entries.push(entry(name, PASTE_KEEP_MS * 10));
    queue.settle(job('u1', 'done'));
    await expect(saving).resolves.toBe(`${real}/${name}`);
    await flush();
    expect(files.list).toHaveBeenLastCalledWith(real);
    expect(files.remove).toHaveBeenCalledExactlyOnceWith([`${real}/${pasteName(1)}`], {
      filesOnly: true,
    });
  });

  it('prunes against the saved paste once the upload succeeded', async () => {
    const queue = new FakeQueue();
    const entries: FileEntry[] = [];
    const { files } = fakeFiles({ entries });
    const { saving } = await startSave(queue, files);
    const { name } = queue.enqueued[0]!.uploads[0]!;
    const at = 5 * PASTE_KEEP_MS;
    entries.push(
      entry(pasteName(1), at - PASTE_KEEP_MS - 1),
      entry(pasteName(2), at),
      entry(name, at),
    );
    queue.settle(job('u1', 'done'));
    await saving;
    await flush();
    expect(files.list).toHaveBeenLastCalledWith(DIR);
    expect(files.remove).toHaveBeenCalledExactlyOnceWith([`${DIR}/${pasteName(1)}`], {
      filesOnly: true,
    });
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
    await flush();
    expect(files.list).toHaveBeenCalledTimes(3);
    expect(files.remove).not.toHaveBeenCalled();
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
    expect(files.remove).not.toHaveBeenCalled();
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

  it('uploads nothing into a folder others can change', async () => {
    const queue = new FakeQueue();
    const { files } = fakeFiles({
      listings: { [TERMAVOX]: { entries: [entry('paste', 0, 'dir', 0o777)] } },
    });
    const error = await rejection(
      savePastedImage({ files, queue, sessionId: 's1', image: pngImage(), extension: 'png' }),
    );
    expect(isUnsafePasteFolderError(error)).toBe(true);
    expect((error as UnsafePasteFolderError).path).toBe(DIR);
    expect(queue.enqueued).toHaveLength(0);
    expect(files.remove).not.toHaveBeenCalled();
  });
});

describe('an image pasted into a pane (plan D-48)', () => {
  const PATH = `${DIR}/paste-20261021-040506-a1b2.png`;

  /** A pane showing session s1 in its terminal; `save` waits for the test unless `path` given. */
  function pane(options: { path?: string | Error } = {}) {
    const terminal = { pasted: [] as string[], paste: vi.fn() };
    terminal.paste.mockImplementation((text: string) => terminal.pasted.push(text));
    const shown: PasteView = { sessionId: 's1', terminal };
    const notices: ImagePasteNotice[] = [];
    const busy = { current: false };
    const pending: Array<PromiseWithResolvers<string>> = [];
    const save = vi.fn((_image: Blob, _extension: string, _sessionId: string) => {
      if (options.path instanceof Error) return Promise.reject(options.path);
      if (options.path !== undefined) return Promise.resolve(options.path);
      const wait = Promise.withResolvers<string>();
      pending.push(wait);
      return wait.promise;
    });
    const paste = (image: Blob = pngImage(), allowed = true) =>
      pasteImage({
        image,
        extension: 'png',
        allowed,
        busy,
        view: () => ({ ...shown }),
        save,
        notice: (notice) => notices.push(notice),
      });
    return { terminal, shown, notices, busy, pending, save, paste };
  }
  const sized = (size: number): Blob => ({ size }) as Blob;

  it('saves it on the session shown and types its path into that terminal', async () => {
    const p = pane({ path: PATH });
    await p.paste();
    expect(p.save).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), 'png', 's1');
    expect(p.terminal.pasted).toEqual([PATH]);
    expect(p.notices).toEqual([]);
    expect(p.busy.current).toBe(false);
  });

  it('quotes a path the shell would split, and refuses one that is unsafe to type', async () => {
    const spaced = pane({ path: "/home/my user/it's.png" });
    await spaced.paste();
    expect(spaced.terminal.pasted).toEqual(["'/home/my user/it'\\''s.png'"]);

    const spoofed = pane({ path: '/home/tv/‮gnp.sh' });
    await spoofed.paste();
    expect(spoofed.terminal.paste).not.toHaveBeenCalled();
    expect(spoofed.notices).toEqual([{ key: 'imagePasteBadPath' }]);

    const broken = pane({ path: '/home/tv/a\nrm -rf ~\n.png' });
    await broken.paste();
    expect(broken.terminal.paste).not.toHaveBeenCalled();
    expect(broken.notices).toEqual([{ key: 'imagePasteBadPath' }]);
  });

  it('types nothing when the pane shows another session or terminal by then', async () => {
    const moved = pane();
    const pasting = moved.paste();
    moved.shown.sessionId = 's2';
    moved.pending[0]!.resolve(PATH);
    await pasting;
    expect(moved.terminal.paste).not.toHaveBeenCalled();
    expect(moved.notices).toEqual([{ key: 'imagePasteNotPasted', path: PATH }]);

    const replaced = pane();
    const again = replaced.paste();
    const other = { paste: vi.fn() };
    replaced.shown.terminal = other;
    replaced.pending[0]!.resolve(PATH);
    await again;
    expect(replaced.terminal.paste).not.toHaveBeenCalled();
    expect(other.paste).not.toHaveBeenCalled();
    expect(replaced.notices).toEqual([{ key: 'imagePasteNotPasted', path: PATH }]);

    const closed = pane();
    const last = closed.paste();
    closed.shown.terminal = null;
    closed.pending[0]!.resolve(PATH);
    await last;
    expect(closed.terminal.paste).not.toHaveBeenCalled();
    expect(closed.notices).toEqual([{ key: 'imagePasteNotPasted', path: PATH }]);
  });

  it(`refuses images over ${PASTE_IMAGE_MAX_BYTES / 1024 / 1024} MiB before sending anything`, async () => {
    expect(PASTE_IMAGE_MAX_BYTES).toBe(32 * 1024 * 1024);
    const p = pane({ path: PATH });
    await p.paste(sized(PASTE_IMAGE_MAX_BYTES + 1));
    expect(p.save).not.toHaveBeenCalled();
    expect(p.notices).toEqual([{ key: 'imagePasteTooLarge' }]);
    expect(p.busy.current).toBe(false);
    await p.paste(sized(PASTE_IMAGE_MAX_BYTES));
    expect(p.save).toHaveBeenCalledOnce();
    expect(p.terminal.pasted).toEqual([PATH]);
  });

  it('ignores image pastes while one is in flight in the pane, without a notice', async () => {
    const p = pane();
    const first = p.paste();
    expect(p.busy.current).toBe(true);
    await p.paste();
    await p.paste(sized(PASTE_IMAGE_MAX_BYTES + 1));
    await p.paste(pngImage(), false);
    expect(p.save).toHaveBeenCalledOnce();
    expect(p.notices).toEqual([]);
    p.pending[0]!.resolve(PATH);
    await first;
    expect(p.busy.current).toBe(false);
    expect(p.terminal.pasted).toEqual([PATH]);
    // The next one runs again.
    const second = p.paste();
    expect(p.save).toHaveBeenCalledTimes(2);
    p.pending[1]!.reject(new FileRequestError(FileCode.PermissionDenied));
    await second;
    expect(p.busy.current).toBe(false);
  });

  it('says why when file transfer is not allowed, the folder is unsafe or the save fails', async () => {
    const off = pane({ path: PATH });
    await off.paste(pngImage(), false);
    expect(off.save).not.toHaveBeenCalled();
    expect(off.notices).toEqual([{ key: 'imagePasteUnavailable' }]);

    const unsafe = pane({ path: new UnsafePasteFolderError(DIR) });
    await unsafe.paste();
    expect(unsafe.notices).toEqual([{ key: 'imagePasteUnsafeFolder', path: DIR }]);
    expect(unsafe.busy.current).toBe(false);

    const denied = new FileRequestError(FileCode.PermissionDenied);
    const failed = pane({ path: denied });
    await failed.paste();
    expect(failed.notices).toEqual([{ key: 'imagePasteFailed', error: denied }]);
    expect(failed.terminal.paste).not.toHaveBeenCalled();
    expect(failed.busy.current).toBe(false);
  });
});
