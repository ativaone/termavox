import type { FileRequest } from '@termdock/protocol';
import { describe, expect, it } from 'vitest';
import { FileRequestError } from '../../lib/files/errors.ts';
import type {
  FileApi,
  TransferListener,
  TransferProgressMessage,
} from '../../lib/files/requests.ts';
import { type TransferJob, TransferQueue, type XhrLike } from '../../lib/files/transfer-queue.ts';
import { sleep } from '../terminal/helpers.ts';

interface Call {
  sessionId: string;
  request: FileRequest;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

/** The tab's connection as the queue sees it: requests answered by the test. */
class FakeApi implements FileApi {
  readonly calls: Call[] = [];
  readonly cancelled: string[] = [];
  readonly listeners = new Set<TransferListener>();

  fileRequest(sessionId: string, request: FileRequest) {
    return new Promise((resolve, reject) => {
      this.calls.push({ sessionId, request, resolve, reject });
    }) as never;
  }

  cancelTransfer(transferId: string): boolean {
    this.cancelled.push(transferId);
    return true;
  }

  subscribeTransfers(listener: TransferListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  progress(message: Omit<TransferProgressMessage, 'type'>): void {
    for (const listener of [...this.listeners]) {
      listener.progress({ type: 'transfer.progress', ...message });
    }
  }

  drop(): void {
    for (const listener of [...this.listeners]) listener.disconnected?.();
  }

  /** Answers call `index` with a minted URL for its op. */
  mint(index: number, transferId: string, size = 100): void {
    const call = this.calls[index]!;
    if (call.request.op === 'upload') {
      call.resolve({ op: 'upload', transferId, url: `/transfer/upload/${transferId}` });
    } else if (call.request.op === 'download') {
      call.resolve({
        op: 'download',
        transferId,
        url: `/transfer/download/${transferId}`,
        name: call.request.path.split('/').pop(),
        size,
      });
    }
  }
}

class FakeXhr implements XhrLike {
  method = '';
  url = '';
  readonly headers: Record<string, string> = {};
  body: Blob | null = null;
  status = 0;
  responseText = '';
  aborted = false;
  readonly upload: XhrLike['upload'] = { onprogress: null };
  onload: XhrLike['onload'] = null;
  onerror: XhrLike['onerror'] = null;
  onabort: XhrLike['onabort'] = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: Blob): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.({});
  }
  sent(loaded: number): void {
    this.upload.onprogress?.({ loaded });
  }
  respond(status: number, text: string): void {
    this.status = status;
    this.responseText = text;
    this.onload?.({});
  }
}

const ENTRY = JSON.stringify({
  entry: { name: 'a', type: 'file', size: 100, mtime: 1, mode: 420 },
});
const flush = () => sleep(0);

function setup(options: { handoffTimeoutMs?: number } = {}) {
  const api = new FakeApi();
  const xhrs: FakeXhr[] = [];
  const downloads: Array<{ url: string; name: string }> = [];
  let clock = 1_000;
  const queue = new TransferQueue({
    api,
    resolveUrl: (path) => `https://term.test${path}`,
    createXhr: () => {
      const xhr = new FakeXhr();
      xhrs.push(xhr);
      return xhr;
    },
    startDownload: (url, name) => downloads.push({ url, name }),
    now: () => clock,
    ...options,
  });
  const settled: TransferJob[] = [];
  queue.onSettled((job) => settled.push(job));
  const job = (id: string) => queue.getSnapshot().find((j) => j.id === id)!;
  const tick = (ms: number) => {
    clock += ms;
  };
  return { api, xhrs, downloads, queue, settled, job, tick };
}

const file = (name: string, size = 100, overwrite = false) => ({
  name,
  size,
  overwrite,
  body: new Blob(['x'.repeat(size)]),
});

describe('transfer queue (plan §5.12)', () => {
  it('runs two at a time and mints a URL only when a slot frees', async () => {
    const { api, xhrs, queue, job, settled } = setup();
    expect(api.listeners.size).toBe(0);
    const [a, b, c] = queue.enqueueUploads('s1', '/srv', [file('a'), file('b'), file('c')]);
    expect(api.listeners.size).toBe(1); // follows the daemon's progress while busy
    expect(api.calls.map((call) => call.request)).toEqual([
      { op: 'upload', dir: '/srv', name: 'a', size: 100, overwrite: false },
      { op: 'upload', dir: '/srv', name: 'b', size: 100, overwrite: false },
    ]);
    expect(job(c!).state).toBe('queued');
    expect(queue.activeUploads()).toBe(3);

    api.mint(0, 'x-a');
    await flush();
    const xhr = xhrs[0]!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('https://term.test/transfer/upload/x-a');
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
    expect(xhr.body?.size).toBe(100);

    xhr.respond(200, ENTRY);
    expect(job(a!)).toMatchObject({ state: 'done', bytes: 100 });
    expect(settled.map((j) => j.id)).toEqual([a]);
    // The slot freed: the third mints now, not before.
    expect(api.calls).toHaveLength(3);
    expect(job(b!).state).toBe('running');
    expect(job(c!).state).toBe('running');
  });

  it("prefers the daemon's progress over the XHR's once it arrives", async () => {
    const { api, xhrs, queue, job, tick } = setup();
    const [id] = queue.enqueueUploads('s1', '/srv', [file('a')]);
    api.mint(0, 'x-a');
    await flush();
    const xhr = xhrs[0]!;
    tick(1_000);
    xhr.sent(50);
    expect(job(id!).bytes).toBe(50);
    api.progress({ transferId: 'x-a', bytes: 20, size: 100, state: 'running' });
    expect(job(id!).bytes).toBe(20);
    tick(1_000);
    xhr.sent(90); // a buffering proxy runs ahead: the bar does not
    expect(job(id!).bytes).toBe(20);
    tick(1_000);
    api.progress({ transferId: 'x-a', bytes: 60, size: 100, state: 'running' });
    expect(job(id!).bytes).toBe(60);
    expect(job(id!).speed).toBeGreaterThan(0);
    // The tab's socket drops: the daemon's count stops, the XHR's takes over again.
    api.drop();
    tick(1_000);
    xhr.sent(95);
    expect(job(id!).bytes).toBe(95);
  });

  it('tells a proxy 413 from a daemon refusal, and HTTP or network failures apart', async () => {
    const { api, xhrs, queue, job } = setup();
    const ids = queue.enqueueUploads('s1', '/srv', [file('a'), file('b')]);
    api.mint(0, 'x-a');
    api.mint(1, 'x-b');
    await flush();
    xhrs[0]!.respond(413, '<html><body>413 Request Entity Too Large</body></html>');
    xhrs[1]!.respond(413, JSON.stringify({ code: 'BAD_REQUEST', message: 'size mismatch' }));
    expect(job(ids[0]!).error).toEqual({ code: 'PROXY_TOO_LARGE', message: 'PROXY_TOO_LARGE' });
    expect(job(ids[1]!).error).toEqual({ code: 'BAD_REQUEST', message: 'size mismatch' });

    const more = queue.enqueueUploads('s1', '/srv', [file('c'), file('d'), file('e')]);
    api.mint(2, 'x-c');
    api.mint(3, 'x-d');
    await flush();
    xhrs[2]!.respond(502, 'Bad Gateway');
    xhrs[3]!.onerror?.({});
    expect(job(more[0]!).error).toEqual({ code: 'TRANSFER_FAILED', message: 'HTTP 502' });
    expect(job(more[1]!).error?.code).toBe('TRANSFER_FAILED');
    // A refused mint (the name exists, no overwrite) fails the job with the daemon's code.
    api.calls[4]!.reject(new FileRequestError('CONFLICT', 'exists'));
    await flush();
    expect(job(more[2]!)).toMatchObject({ state: 'failed', error: { code: 'CONFLICT' } });
  });

  it("fails an upload the daemon reports failed, with the daemon's code", async () => {
    const { api, xhrs, queue, job } = setup();
    const [id] = queue.enqueueUploads('s1', '/srv', [file('a')]);
    api.mint(0, 'x-a');
    await flush();
    api.progress({
      transferId: 'x-a',
      bytes: 40,
      size: 100,
      state: 'failed',
      code: 'FILE_OP_FAILED',
    });
    expect(job(id!)).toMatchObject({ state: 'failed', error: { code: 'FILE_OP_FAILED' } });
    expect(xhrs[0]!.aborted).toBe(true);
    xhrs[0]!.respond(500, JSON.stringify({ code: 'INTERNAL', message: 'late' }));
    expect(job(id!).error?.code).toBe('FILE_OP_FAILED'); // the late answer changes nothing
  });

  it('cancels queued, minting and sending jobs, and voids their URLs', async () => {
    const { api, xhrs, queue, job } = setup();
    const [sending, minting, queued] = queue.enqueueUploads('s1', '/srv', [
      file('a'),
      file('b'),
      file('c'),
    ]);
    api.mint(0, 'x-a');
    await flush();
    queue.cancel(queued!);
    expect(job(queued!).state).toBe('cancelled');
    queue.cancel(sending!);
    expect(xhrs[0]!.aborted).toBe(true);
    expect(api.cancelled).toEqual(['x-a']);
    expect(job(sending!).state).toBe('cancelled');
    queue.cancel(minting!);
    api.mint(1, 'x-b'); // the URL arrives after the cancel: voided, never used
    await flush();
    expect(api.cancelled).toEqual(['x-a', 'x-b']);
    expect(xhrs).toHaveLength(1);
    expect(job(minting!).state).toBe('cancelled');
    expect(queue.activeUploads()).toBe(0);
    expect(api.listeners.size).toBe(0); // idle again: no longer following progress
  });

  it('retries a failed job with a fresh URL', async () => {
    const { api, xhrs, queue, job } = setup();
    const [id] = queue.enqueueUploads('s1', '/srv', [file('a', 100, true)]);
    api.calls[0]!.reject(new FileRequestError('SESSION_NOT_CONNECTED'));
    await flush();
    expect(job(id!).state).toBe('failed');
    queue.retry(id!);
    expect(job(id!)).toMatchObject({ state: 'running', error: null, bytes: 0 });
    expect(api.calls[1]!.request).toMatchObject({ op: 'upload', name: 'a', overwrite: true });
    api.mint(1, 'x-a2');
    await flush();
    xhrs[0]!.respond(200, ENTRY);
    expect(job(id!).state).toBe('done');
  });

  it('hands downloads to the browser and follows their progress', async () => {
    const { api, downloads, queue, job } = setup();
    const [id] = queue.enqueueDownloads('s1', '/var/log', [
      { path: '/var/log/syslog', name: 'syslog', size: 10 },
    ]);
    expect(api.calls[0]!.request).toEqual({ op: 'download', path: '/var/log/syslog' });
    api.mint(0, 'd-1', 2_000);
    await flush();
    expect(downloads).toEqual([{ url: 'https://term.test/transfer/download/d-1', name: 'syslog' }]);
    expect(job(id!).size).toBe(2_000); // the size when the daemon opened it
    api.progress({ transferId: 'd-1', bytes: 500, size: 2_000, state: 'running' });
    expect(job(id!).bytes).toBe(500);
    api.progress({ transferId: 'd-1', bytes: 2_000, size: 2_000, state: 'done' });
    expect(job(id!)).toMatchObject({ state: 'done', bytes: 2_000, untracked: false });
  });

  it('hands downloads to the browser one at a time', async () => {
    const { api, queue, job } = setup();
    const [first, second] = queue.enqueueDownloads('s1', '/', [
      { path: '/a', name: 'a', size: 1 },
      { path: '/b', name: 'b', size: 1 },
    ]);
    await flush();
    // The second is minted only once the browser took the first (its URL lives 60 s).
    expect(api.calls).toHaveLength(1);
    api.mint(0, 'd-a');
    await flush();
    expect(api.calls).toHaveLength(1);
    api.progress({ transferId: 'd-a', bytes: 0, size: 100, state: 'running' });
    await flush();
    expect(api.calls).toHaveLength(2);
    expect(job(first!).state).toBe('running');
    expect(job(second!).state).toBe('running');
  });

  it('lets a download go on untracked when its progress cannot be followed', async () => {
    const { api, queue, job } = setup({ handoffTimeoutMs: 20 });
    const [quiet, dropped] = queue.enqueueDownloads('s1', '/', [
      { path: '/a', name: 'a', size: 1 },
      { path: '/b', name: 'b', size: 1 },
    ]);
    await flush();
    api.mint(0, 'd-a');
    await flush();
    await sleep(40);
    // No progress at all: it went on in the browser's own list, and the next one could go.
    expect(job(quiet!)).toMatchObject({ state: 'done', untracked: true });
    expect(api.calls).toHaveLength(2);
    api.mint(1, 'd-b');
    await flush();
    api.progress({ transferId: 'd-b', bytes: 0, size: 100, state: 'running' });
    await sleep(40);
    expect(job(dropped!).state).toBe('running');
    // Progress that stops because the tab's socket dropped: the same.
    api.drop();
    expect(job(dropped!)).toMatchObject({ state: 'done', untracked: true });
  });

  it('clears the finished jobs of one session only', async () => {
    const { api, queue } = setup();
    const [failed] = queue.enqueueUploads('s1', '/', [file('a')]);
    queue.enqueueUploads('s2', '/', [file('b')]);
    api.calls[0]!.reject(new FileRequestError('CONFLICT'));
    api.calls[1]!.reject(new FileRequestError('CONFLICT'));
    await flush();
    const [running] = queue.enqueueUploads('s1', '/', [file('c')]);
    queue.clearFinished('s1');
    const left = queue.getSnapshot().map((j) => [j.sessionId, j.id]);
    expect(left).toContainEqual(['s1', running]);
    expect(left.map(([, id]) => id)).not.toContain(failed);
    expect(left.filter(([session]) => session === 's2')).toHaveLength(1);
  });
});
