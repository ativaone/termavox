import { Store } from '../terminal/store.ts';
import { ClientFileCode, FileCode, fileErrorCode } from './errors.ts';
import type { FileApi, TransferProgressMessage } from './requests.ts';

/**
 * The browser tab's uploads and downloads (plan §5.12): one queue for the whole tab, outside
 * React, so transfers keep running when a panel closes or a pane changes. Two run at a time; a
 * job mints its single-use URL only when its turn comes (the URL lives 60 s). An upload is an
 * XHR POST of the file's bytes; a download is handed to the browser's own download manager. The
 * bar follows the daemon's `transfer.progress` (bytes written to the server, or sent towards the
 * browser) once it arrives, the XHR's upload progress until then. Framework-free: the XHR, the
 * download hand-off and the clock are injected.
 */

export type TransferDirection = 'upload' | 'download';
export type TransferJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TransferJob {
  readonly id: string;
  readonly sessionId: string;
  readonly direction: TransferDirection;
  /** Upload: the name it is stored under. Download: the file's name. */
  readonly name: string;
  /** The folder it goes to (upload) or comes from (download). */
  readonly dir: string;
  readonly size: number;
  /** Bytes moved so far: the daemon's count when it reports one, the XHR's before that. */
  readonly bytes: number;
  readonly state: TransferJobState;
  readonly error: { code: string; message: string } | null;
  /** Bytes per second, smoothed, while running (null until measured). */
  readonly speed: number | null;
  /**
   * A download handed to the browser whose progress this tab cannot see any more (the tab's
   * connection dropped, or no progress came): it goes on in the browser's download list.
   */
  readonly untracked: boolean;
  /** An upload that replaces an existing file. */
  readonly overwrite: boolean;
  readonly finishedAt: number | null;
}

// Method-shorthand types are bivariant, so the DOM's XMLHttpRequest satisfies XhrLike as is.
type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

/** The part of XMLHttpRequest an upload uses (tests inject a fake). */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  readonly upload: { onprogress: Handler<{ loaded: number }> | null };
  onload: Handler<unknown> | null;
  onerror: Handler<unknown> | null;
  onabort: Handler<unknown> | null;
}

export interface TransferQueueDeps {
  api: FileApi;
  /** The absolute URL of a minted `/transfer/…` path. */
  resolveUrl(path: string): string;
  createXhr(): XhrLike;
  /** Hands a download URL to the browser (an `<a download>` click). */
  startDownload(url: string, name: string): void;
  now?(): number;
  /** Jobs running at once (plan §5.12: two per browser tab). */
  concurrency?: number;
  /** A handed-off download that reports no progress for this long goes on untracked. */
  handoffTimeoutMs?: number;
}

export interface UploadInput {
  /** The name to store it under (after the conflict choice). */
  name: string;
  size: number;
  overwrite: boolean;
  body: Blob;
}

export interface DownloadInput {
  path: string;
  name: string;
  size: number;
}

export const TRANSFER_CONCURRENCY = 2;
const HANDOFF_TIMEOUT_MS = 65_000;
/** Bar updates from XHR progress events, at most this often per job. */
const EMIT_EVERY_MS = 200;
/** Speed is measured over windows of at least this length. */
const SPEED_WINDOW_MS = 500;

interface Runtime {
  /** Bumped by every start and by cancel: late callbacks of an older attempt are ignored. */
  attempt: number;
  body: Blob | null;
  /** Download: the remote path. */
  path: string | null;
  xhr: XhrLike | null;
  transferId: string | null;
  serverBytes: number | null;
  xhrBytes: number;
  sample: { at: number; bytes: number } | null;
  lastEmit: number;
  handoff: ReturnType<typeof setTimeout> | null;
}

const FINISHED: ReadonlySet<TransferJobState> = new Set(['done', 'failed', 'cancelled']);

export function isFinished(job: TransferJob): boolean {
  return FINISHED.has(job.state);
}

/** A job that holds a slot: running and still followed. */
function occupiesSlot(job: TransferJob): boolean {
  return job.state === 'running' && !job.untracked;
}

/** Reads `{ code, message }` or `{ entry }` from a transfer response body; null if it is not ours. */
function parseBody(text: string): { code?: string; message?: string; entry?: unknown } | null {
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body !== 'object' || body === null) return null;
    const { code, message, entry } = body as Record<string, unknown>;
    if (typeof code === 'string') {
      return { code, message: typeof message === 'string' ? message : code };
    }
    if (typeof entry === 'object' && entry !== null) return { entry };
    return null;
  } catch {
    return null;
  }
}

export class TransferQueue {
  readonly #store = new Store<readonly TransferJob[]>([]);
  readonly #runtime = new Map<string, Runtime>();
  readonly #byTransfer = new Map<string, string>();
  readonly #settled = new Set<(job: TransferJob) => void>();
  readonly #deps: TransferQueueDeps;
  readonly #now: () => number;
  readonly #concurrency: number;
  readonly #handoffMs: number;
  #nextId = 0;
  #unsubscribe: (() => void) | null = null;
  /**
   * The download handed to the browser and not confirmed by the daemon yet. The next one waits
   * for it: a browser can drop a download it was handed while another is still starting (a page
   * navigation that becomes a download replaces the previous one).
   */
  #handing: string | null = null;
  readonly #handingWaiters: Array<() => void> = [];

  constructor(deps: TransferQueueDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#concurrency = Math.max(1, deps.concurrency ?? TRANSFER_CONCURRENCY);
    this.#handoffMs = deps.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS;
  }

  readonly getSnapshot = (): readonly TransferJob[] => this.#store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener);

  /** Called with each job that finishes (done, failed or cancelled). */
  onSettled(listener: (job: TransferJob) => void): () => void {
    this.#settled.add(listener);
    return () => {
      this.#settled.delete(listener);
    };
  }

  /** Uploads queued or running (the page asks before unloading while there are any). */
  activeUploads(): number {
    return this.getSnapshot().filter(
      (job) => job.direction === 'upload' && (job.state === 'queued' || job.state === 'running'),
    ).length;
  }

  enqueueUploads(sessionId: string, dir: string, uploads: readonly UploadInput[]): string[] {
    return this.#enqueue(
      uploads.map((upload) => ({
        job: this.#newJob(sessionId, 'upload', upload.name, dir, upload.size, upload.overwrite),
        body: upload.body,
        path: null,
      })),
    );
  }

  enqueueDownloads(sessionId: string, dir: string, downloads: readonly DownloadInput[]): string[] {
    return this.#enqueue(
      downloads.map((download) => ({
        job: this.#newJob(sessionId, 'download', download.name, dir, download.size, false),
        body: null,
        path: download.path,
      })),
    );
  }

  /** Stops a queued or running job (its URL is voided, its XHR aborted). */
  cancel(id: string): void {
    const job = this.#job(id);
    const rt = this.#runtime.get(id);
    if (!job || !rt || isFinished(job)) return;
    rt.attempt++;
    rt.xhr?.abort();
    if (rt.transferId && job.state === 'running') this.#deps.api.cancelTransfer(rt.transferId);
    this.#finish(id, { state: 'cancelled' });
  }

  /** Queues a failed or cancelled job again (a fresh URL; an upload sends the file again). */
  retry(id: string): void {
    const job = this.#job(id);
    const rt = this.#runtime.get(id);
    if (!job || !rt || (job.state !== 'failed' && job.state !== 'cancelled')) return;
    rt.attempt++;
    this.#resetRuntime(rt);
    this.#patch(id, {
      state: 'queued',
      bytes: 0,
      error: null,
      speed: null,
      untracked: false,
      finishedAt: null,
    });
    this.#pump();
  }

  /** Drops finished jobs (done, failed, cancelled) of a session from the list. */
  clearFinished(sessionId: string): void {
    const jobs = this.getSnapshot();
    const keep = jobs.filter((job) => job.sessionId !== sessionId || !isFinished(job));
    if (keep.length === jobs.length) return;
    for (const job of jobs) {
      if (keep.includes(job)) continue;
      const rt = this.#runtime.get(job.id);
      if (rt) this.#resetRuntime(rt);
      this.#runtime.delete(job.id);
    }
    this.#store.set(keep);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  #newJob(
    sessionId: string,
    direction: TransferDirection,
    name: string,
    dir: string,
    size: number,
    overwrite: boolean,
  ): TransferJob {
    return {
      id: `t${++this.#nextId}`,
      sessionId,
      direction,
      name,
      dir,
      size,
      bytes: 0,
      state: 'queued',
      error: null,
      speed: null,
      untracked: false,
      overwrite,
      finishedAt: null,
    };
  }

  #enqueue(items: Array<{ job: TransferJob; body: Blob | null; path: string | null }>): string[] {
    if (items.length === 0) return [];
    for (const { job, body, path } of items) {
      this.#runtime.set(job.id, {
        attempt: 0,
        body,
        path,
        xhr: null,
        transferId: null,
        serverBytes: null,
        xhrBytes: 0,
        sample: null,
        lastEmit: 0,
        handoff: null,
      });
    }
    this.#store.set([...this.getSnapshot(), ...items.map((item) => item.job)]);
    this.#pump();
    return items.map((item) => item.job.id);
  }

  #job(id: string): TransferJob | undefined {
    return this.getSnapshot().find((job) => job.id === id);
  }

  #patch(id: string, patch: Partial<TransferJob>): void {
    const jobs = this.getSnapshot();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) return;
    const next = [...jobs];
    next[index] = { ...jobs[index]!, ...patch };
    this.#store.set(next);
  }

  #resetRuntime(rt: Runtime): void {
    if (rt.handoff) clearTimeout(rt.handoff);
    if (rt.transferId) this.#byTransfer.delete(rt.transferId);
    rt.xhr = null;
    rt.transferId = null;
    rt.serverBytes = null;
    rt.xhrBytes = 0;
    rt.sample = null;
    rt.lastEmit = 0;
    rt.handoff = null;
  }

  #finish(id: string, patch: Partial<TransferJob>): void {
    this.#releaseHandoff(id);
    const rt = this.#runtime.get(id);
    if (rt) {
      if (rt.handoff) clearTimeout(rt.handoff);
      rt.handoff = null;
      rt.xhr = null;
    }
    this.#patch(id, { speed: null, finishedAt: this.#now(), ...patch });
    const job = this.#job(id);
    if (job) for (const listener of [...this.#settled]) listener(job);
    this.#pump();
  }

  #fail(id: string, code: string, message: string = code): void {
    this.#finish(id, { state: 'failed', error: { code, message } });
  }

  /** Starts queued jobs while slots are free; follows the daemon's progress while any run. */
  #pump(): void {
    const jobs = this.getSnapshot();
    let running = jobs.filter(occupiesSlot).length;
    for (const job of jobs) {
      if (running >= this.#concurrency) break;
      if (job.state !== 'queued') continue;
      running++;
      this.#start(job);
    }
    const busy = this.getSnapshot().some(
      (job) => job.state === 'running' || job.state === 'queued',
    );
    if (busy && !this.#unsubscribe) {
      this.#unsubscribe = this.#deps.api.subscribeTransfers({
        progress: (message) => this.#onServerProgress(message),
        disconnected: () => this.#onDisconnected(),
      });
    } else if (!busy && this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }
  }

  #start(job: TransferJob): void {
    const rt = this.#runtime.get(job.id)!;
    const attempt = ++rt.attempt;
    this.#resetRuntime(rt);
    this.#patch(job.id, { state: 'running', bytes: 0, error: null, speed: null });
    const current = () => this.#runtime.get(job.id)?.attempt === attempt;
    if (job.direction === 'upload') void this.#upload(job, rt, current);
    else void this.#download(job, rt, current);
  }

  async #mint<T extends { transferId: string; url: string }>(
    job: TransferJob,
    rt: Runtime,
    current: () => boolean,
    request: () => Promise<T>,
  ): Promise<{ minted: T; url: string } | null> {
    let minted: T;
    try {
      minted = await request();
    } catch (err) {
      if (current())
        this.#fail(job.id, fileErrorCode(err), err instanceof Error ? err.message : '');
      return null;
    }
    if (!current()) {
      // Cancelled (or cleared) while minting: void the URL nobody will use.
      this.#deps.api.cancelTransfer(minted.transferId);
      return null;
    }
    let url: string;
    try {
      url = this.#deps.resolveUrl(minted.url);
    } catch {
      this.#deps.api.cancelTransfer(minted.transferId);
      this.#fail(job.id, FileCode.Internal);
      return null;
    }
    rt.transferId = minted.transferId;
    this.#byTransfer.set(minted.transferId, job.id);
    return { minted, url };
  }

  async #upload(job: TransferJob, rt: Runtime, current: () => boolean): Promise<void> {
    const body = rt.body;
    if (!body) {
      this.#fail(job.id, FileCode.Internal);
      return;
    }
    const got = await this.#mint(job, rt, current, () =>
      this.#deps.api.fileRequest(job.sessionId, {
        op: 'upload',
        dir: job.dir,
        name: job.name,
        size: job.size,
        overwrite: job.overwrite,
      }),
    );
    if (!got) return;
    const xhr = this.#deps.createXhr();
    rt.xhr = xhr;
    xhr.open('POST', got.url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (!current()) return;
      rt.xhrBytes = event.loaded;
      this.#progress(job.id, rt);
    };
    xhr.onload = () => {
      if (!current()) return;
      const parsed = parseBody(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && parsed?.entry) {
        this.#finish(job.id, { state: 'done', bytes: job.size });
      } else if (parsed?.code) {
        this.#fail(job.id, parsed.code, parsed.message);
      } else if (xhr.status === 413) {
        // Ours would carry `{ code, message }`: a 413 without it is a proxy's size limit.
        this.#fail(job.id, ClientFileCode.ProxyTooLarge);
      } else {
        this.#fail(job.id, ClientFileCode.TransferFailed, `HTTP ${xhr.status}`);
      }
    };
    xhr.onerror = () => {
      if (current()) this.#fail(job.id, ClientFileCode.TransferFailed);
    };
    xhr.onabort = () => {
      // Only cancel() aborts, and it settles the job itself.
    };
    xhr.send(body);
  }

  async #download(job: TransferJob, rt: Runtime, current: () => boolean): Promise<void> {
    const path = rt.path;
    if (!path) {
      this.#fail(job.id, FileCode.Internal);
      return;
    }
    // Minted only once it is this download's turn: its URL lives 60 s.
    while (this.#handing !== null) {
      await new Promise<void>((resolve) => this.#handingWaiters.push(resolve));
    }
    if (!current()) {
      this.#wakeHandoff();
      return;
    }
    this.#handing = job.id;
    const got = await this.#mint(job, rt, current, () =>
      this.#deps.api.fileRequest(job.sessionId, { op: 'download', path }),
    );
    if (!got) {
      this.#releaseHandoff(job.id);
      return;
    }
    // The size when the daemon opened it (a growing log), and the name it will save under.
    this.#patch(job.id, { size: got.minted.size, name: got.minted.name });
    this.#deps.startDownload(got.url, got.minted.name);
    rt.handoff = setTimeout(() => {
      rt.handoff = null;
      if (current() && rt.serverBytes === null) this.#handOff(job.id);
    }, this.#handoffMs);
  }

  /** The browser took `id` (the daemon reported it) or it ended: the next download may go. */
  #releaseHandoff(id: string): void {
    if (this.#handing !== id) return;
    this.#handing = null;
    this.#wakeHandoff();
  }

  #wakeHandoff(): void {
    this.#handingWaiters.shift()?.();
  }

  /** A download goes on in the browser's own list, out of this tab's sight. */
  #handOff(id: string): void {
    this.#finish(id, { state: 'done', untracked: true });
  }

  #onServerProgress(message: TransferProgressMessage): void {
    const id = this.#byTransfer.get(message.transferId);
    const job = id ? this.#job(id) : undefined;
    const rt = id ? this.#runtime.get(id) : undefined;
    if (!id || !job || !rt || job.state !== 'running') return;
    this.#releaseHandoff(id);
    rt.serverBytes = message.bytes;
    if (rt.handoff) {
      clearTimeout(rt.handoff);
      rt.handoff = null;
    }
    switch (message.state) {
      case 'running':
        this.#progress(id, rt, true);
        return;
      case 'done':
        // An upload is done when its POST answers with the entry; a download when the daemon
        // has sent every byte.
        if (job.direction === 'download') this.#finish(id, { state: 'done', bytes: message.bytes });
        else this.#progress(id, rt, true);
        return;
      case 'failed':
      case 'cancelled': {
        rt.attempt++;
        rt.xhr?.abort();
        this.#fail(
          id,
          message.code ??
            (message.state === 'cancelled' ? FileCode.Cancelled : ClientFileCode.TransferFailed),
        );
        return;
      }
    }
  }

  /** The tab's socket dropped: the daemon's progress stops, so uploads follow their XHR again. */
  #onDisconnected(): void {
    for (const job of this.getSnapshot()) {
      if (job.state !== 'running') continue;
      const rt = this.#runtime.get(job.id);
      if (!rt) continue;
      rt.serverBytes = null;
      rt.sample = null;
      if (job.direction === 'download' && rt.transferId) this.#handOff(job.id);
      else if (job.direction === 'upload') this.#progress(job.id, rt, true);
    }
  }

  #progress(id: string, rt: Runtime, force = false): void {
    const job = this.#job(id);
    if (job?.state !== 'running') return;
    const bytes = Math.min(job.size, rt.serverBytes ?? rt.xhrBytes);
    const now = this.#now();
    let speed = job.speed;
    const sample = rt.sample;
    if (!sample || bytes < sample.bytes) {
      rt.sample = { at: now, bytes };
    } else if (now - sample.at >= SPEED_WINDOW_MS) {
      const instant = ((bytes - sample.bytes) * 1000) / (now - sample.at);
      speed = speed === null ? instant : speed * 0.6 + instant * 0.4;
      rt.sample = { at: now, bytes };
    }
    if (!force && now - rt.lastEmit < EMIT_EVERY_MS && bytes < job.size) return;
    rt.lastEmit = now;
    if (bytes !== job.bytes || speed !== job.speed) this.#patch(id, { bytes, speed });
  }
}
