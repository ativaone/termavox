import type {
  ClientMessage,
  FileRequest,
  FileResultOf,
  ServerMessage,
} from '@termavox/protocol/client';
import { ClientFileCode, FileCode, FileRequestError } from './errors.ts';

/**
 * The file panel's side of the tab's WebSocket (plan §5.12): `files.request` → exactly one
 * `files.result` matched by `requestId`, `files.progress` for a running remove, `files.cancel`,
 * and the `transfer.progress` of uploads and downloads this tab minted. `TermavoxConnection`
 * owns one and feeds it; it has no socket of its own. Framework-free.
 */

/** An answer that takes longer than this fails with TIMEOUT (a remove reporting progress never). */
export const FILE_REQUEST_TIMEOUT_MS = 30_000;

export type TransferProgressMessage = Extract<ServerMessage, { type: 'transfer.progress' }>;

export interface TransferListener {
  progress(message: TransferProgressMessage): void;
  /** The tab's WebSocket dropped: progress of transfers minted on it stops arriving. */
  disconnected?(): void;
}

export interface FileRequestOptions {
  /** Aborting sends `files.cancel`; the daemon then answers CANCELLED (a running remove). */
  signal?: AbortSignal;
  /** `files.progress` of this request: entries removed so far. */
  onProgress?(removed: number): void;
}

/** What the panel and the transfer queue need from the tab's connection. */
export interface FileApi {
  fileRequest<R extends FileRequest>(
    sessionId: string,
    request: R,
    options?: FileRequestOptions,
  ): Promise<FileResultOf<R['op']>>;
  /** Stops an upload or a download, or voids its unused URL. False when not connected. */
  cancelTransfer(transferId: string): boolean;
  subscribeTransfers(listener: TransferListener): () => void;
}

export interface FileRequestsOptions {
  /** Sends a message on the tab's socket; false when it is not connected. */
  send(message: ClientMessage): boolean;
  timeoutMs?: number;
  /** Request ids, unique per connection (at most 64 characters). */
  newId?(): string;
}

interface Pending {
  op: FileRequest['op'];
  resolve(result: unknown): void;
  reject(error: FileRequestError): void;
  timer: ReturnType<typeof setTimeout> | null;
  onProgress: ((removed: number) => void) | undefined;
  detach(): void;
}

function defaultIds(): () => string {
  const prefix = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  return () => `f-${prefix}-${(++counter).toString(36)}`;
}

export class FileRequests implements FileApi {
  readonly #send: (message: ClientMessage) => boolean;
  readonly #timeoutMs: number;
  readonly #newId: () => string;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<TransferListener>();

  constructor(options: FileRequestsOptions) {
    this.#send = options.send;
    this.#timeoutMs = options.timeoutMs ?? FILE_REQUEST_TIMEOUT_MS;
    this.#newId = options.newId ?? defaultIds();
  }

  /** Requests in flight (tests, diagnostics). */
  get pending(): number {
    return this.#pending.size;
  }

  fileRequest<R extends FileRequest>(
    sessionId: string,
    request: R,
    options: FileRequestOptions = {},
  ): Promise<FileResultOf<R['op']>> {
    const { signal, onProgress } = options;
    return new Promise<FileResultOf<R['op']>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new FileRequestError(FileCode.Cancelled));
        return;
      }
      const requestId = this.#newId();
      const onAbort = () => {
        this.#send({ type: 'files.cancel', requestId });
      };
      const pending: Pending = {
        op: request.op,
        resolve: resolve as (result: unknown) => void,
        reject,
        timer: null,
        onProgress,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      if (!this.#send({ type: 'files.request', requestId, sessionId, request })) {
        reject(new FileRequestError(FileCode.ConnectionLost));
        return;
      }
      pending.timer = setTimeout(() => {
        if (this.#pending.get(requestId) !== pending) return;
        this.#settle(requestId);
        reject(new FileRequestError(ClientFileCode.Timeout));
      }, this.#timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(requestId, pending);
    });
  }

  cancelTransfer(transferId: string): boolean {
    return this.#send({ type: 'transfer.cancel', transferId });
  }

  subscribeTransfers(listener: TransferListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Feeds a control message; true when it was one of the file panel's. */
  handle(message: ServerMessage): boolean {
    switch (message.type) {
      case 'files.result': {
        const pending = this.#settle(message.requestId);
        if (!pending) return true; // late (timed out) or unknown: dropped
        if (message.error) {
          pending.reject(new FileRequestError(message.error.code, message.error.message));
        } else if (message.result && message.result.op === pending.op) {
          pending.resolve(message.result);
        } else {
          pending.reject(new FileRequestError(FileCode.Internal, 'malformed files.result'));
        }
        return true;
      }
      case 'files.progress': {
        const pending = this.#pending.get(message.requestId);
        if (!pending) return true;
        // A remove that reports progress is alive: no timeout while it runs (plan §5.12).
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = null;
        pending.onProgress?.(message.removed);
        return true;
      }
      case 'transfer.progress':
        for (const listener of [...this.#listeners]) listener.progress(message);
        return true;
      default:
        return false;
    }
  }

  /** The socket dropped: every request in flight fails with CONNECTION_LOST. */
  disconnected(): void {
    const pending = [...this.#pending.keys()];
    for (const requestId of pending) {
      this.#settle(requestId)?.reject(new FileRequestError(FileCode.ConnectionLost));
    }
    for (const listener of [...this.#listeners]) listener.disconnected?.();
  }

  #settle(requestId: string): Pending | undefined {
    const pending = this.#pending.get(requestId);
    if (!pending) return undefined;
    this.#pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.detach();
    return pending;
  }
}
