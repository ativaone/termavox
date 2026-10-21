import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type FileEntry, TRANSFER_PATH } from '@termavox/protocol';
import { ErrorCode, isTermavoxError, TermavoxError } from '@termavox/shared';
import { type Logger, silentLogger } from '../config/logger.ts';
import { hostText } from '../core/host-text.ts';
import {
  type AttachmentClient,
  type FileHost,
  SftpError,
  type SftpHandle,
  type SftpSession,
} from '../core/types.ts';
import { clientAddress, type TrustedProxies } from '../ws/client-ip.ts';
import type { AuthSessionValidator } from '../ws/types.ts';
import { contentDisposition } from './content-disposition.ts';
import { fileError } from './errors.ts';
import { joinPath } from './paths.ts';
import { entryAt, fileType } from './remote-fs.ts';
import type { FileSettings } from './settings.ts';
import { SftpFileReader, SftpFileWriter } from './sftp-io.ts';
import { commitUpload, downloadable, keptMode, tempName } from './transfer-fs.ts';
import { TOKEN_PATTERN, type TransferDirection, type TransferGrant } from './transfer-tokens.ts';
import { type ActiveTransfer, endOf, TransferStop, type Transfers } from './transfers.ts';

/** An upload that sends nothing for this long is stopped (plan §5.12 "Limits"). */
export const UPLOAD_IDLE_TIMEOUT_MS = 60_000;
/** A download whose response takes nothing for this long is stopped (plan §5.12 "Limits"). */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
/**
 * While transfers run, their auth sessions are checked this often: a sign-out whose revoke never
 * reached the daemon still stops them (the WebSocket's revalidation covers its connections only,
 * and a download outlives the tab that started it).
 */
export const TRANSFER_REVALIDATE_INTERVAL_MS = 60_000;
/**
 * Checks in a row that failed (the store did not answer) after which an auth session's transfers
 * stop, as its WebSocket connections close (a passing outage is ridden out).
 */
export const TRANSFER_REVALIDATE_MAX_FAILURES = 3;
/** setuid and setgid: a write by the file's owner clears them, so they are set last. */
const SET_ID_BITS = 0o6000;
/** Same cap as the WebSocket's (and web's audit rows). */
const MAX_USER_AGENT = 256;
const ROUTE = new RegExp(`^${TRANSFER_PATH}/(upload|download)/([^/]+)$`);

/** HTTP status of each error code a transfer answers with. */
const STATUS: Record<string, number> = {
  [ErrorCode.BadRequest]: 400,
  [ErrorCode.NameInvalid]: 400,
  [ErrorCode.Unauthenticated]: 401,
  [ErrorCode.Forbidden]: 403,
  [ErrorCode.PermissionDenied]: 403,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.Conflict]: 409,
  [ErrorCode.Cancelled]: 409,
  [ErrorCode.RateLimited]: 429,
  [ErrorCode.Internal]: 500,
  [ErrorCode.FileOpFailed]: 502,
  [ErrorCode.SessionNotConnected]: 503,
  [ErrorCode.SftpUnavailable]: 503,
  [ErrorCode.FilesDisabled]: 503,
};

/** What the routes need from the file service. */
export interface TransferBackend {
  readonly transfers: Transfers;
  settings(): FileSettings;
  fileHost(sessionId: string): FileHost | undefined;
  /** Keeps the session's SFTP channel from the idle close until the returned function is called. */
  holdChannel(host: FileHost): () => void;
  /**
   * A `file.upload` / `file.download` row, while the file audit is on. A download's is written
   * when it ends, with the bytes its response took and whether it completed.
   */
  auditTransfer(
    host: FileHost,
    actor: { userId: string; client: AttachmentClient },
    type: 'file.upload' | 'file.download',
    detail: TransferAuditDetail,
  ): void;
}

export type TransferAuditDetail = {
  path: string;
  /** An upload's bytes; a download's file size. */
  size: number;
  /** A download: the bytes sent. */
  bytes?: number;
  /** A download: all of them were. */
  completed?: boolean;
};

export interface TransferRoutesOptions {
  /** The only `Origin` an upload may come from. */
  publicOrigin: string;
  authSessions: AuthSessionValidator;
  /** Whose `X-Forwarded-For` names the client (the WebSocket's rule). */
  trustedProxies: TrustedProxies;
  backend: TransferBackend;
  logger?: Logger;
  /** Default UPLOAD_IDLE_TIMEOUT_MS (tests). */
  uploadIdleMs?: number;
  /** Default DOWNLOAD_IDLE_TIMEOUT_MS (tests). */
  downloadIdleMs?: number;
  /** Default TRANSFER_REVALIDATE_INTERVAL_MS (tests). */
  revalidateIntervalMs?: number;
}

/** A used URL: its grant, the session, the running transfer and the client that used it. */
interface Use {
  grant: TransferGrant;
  host: FileHost;
  transfer: ActiveTransfer;
  client: AttachmentClient;
  release(): void;
}

type UploadGrant = Extract<TransferGrant, { direction: 'upload' }>;

/**
 * The transfer routes (plan §5.12 "Transfers (HTTP)") beside the WebSocket on the daemon's
 * listener: `POST /transfer/upload/<token>` with the file's bytes, `GET /transfer/download/<token>`
 * for the browser's download manager. Bytes never go over the WebSocket. A URL is single use and
 * bound to its grant; using it re-validates the auth session and counts against the user's
 * transfers, and the auth session is checked again while the transfer runs.
 */
export class TransferRoutes {
  readonly #options: TransferRoutesOptions;
  readonly #backend: TransferBackend;
  readonly #log: Logger;
  readonly #uploadIdleMs: number;
  readonly #downloadIdleMs: number;
  readonly #revalidateIntervalMs: number;
  /** Runs while transfers do (#revalidate). */
  #revalidateTimer: ReturnType<typeof setInterval> | null = null;
  #revalidating = false;
  /** Checks in a row that failed, by auth session. */
  readonly #revalidateFailures = new Map<string, number>();

  constructor(options: TransferRoutesOptions) {
    this.#options = options;
    this.#backend = options.backend;
    this.#log = (options.logger ?? silentLogger()).child({ component: 'transfers' });
    this.#uploadIdleMs = options.uploadIdleMs ?? UPLOAD_IDLE_TIMEOUT_MS;
    this.#downloadIdleMs = options.downloadIdleMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
    this.#revalidateIntervalMs = options.revalidateIntervalMs ?? TRANSFER_REVALIDATE_INTERVAL_MS;
  }

  /** The paths these routes answer: everything under TRANSFER_PATH. */
  static owns(pathname: string): boolean {
    return pathname === TRANSFER_PATH || pathname.startsWith(`${TRANSFER_PATH}/`);
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    this.#route(req, res).catch((err: unknown) => {
      this.#log.error({ err }, 'transfer route failed');
      this.#error(res, new TermavoxError(ErrorCode.Internal, 'internal error'), { close: true });
    });
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = ROUTE.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
    const close = req.method === 'POST';
    if (!match) {
      this.#error(res, new TermavoxError(ErrorCode.NotFound, 'not found'), { close });
      return;
    }
    const direction = match[1] as TransferDirection;
    const token = match[2]!;
    if (direction === 'upload') {
      if (req.method === 'OPTIONS') return this.#preflight(req, res);
      if (req.method !== 'POST') return this.#methodNotAllowed(res, 'POST, OPTIONS', close);
      return this.#upload(req, res, token);
    }
    if (req.method !== 'GET') return this.#methodNotAllowed(res, 'GET', close);
    return this.#download(req, res, token);
  }

  // ── upload ───────────────────────────────────────────────────────────────────────────────────

  /** The browser's CORS preflight (the web app and the daemon may run on two ports in dev). */
  #preflight(req: IncomingMessage, res: ServerResponse): void {
    if (req.headers.origin !== this.#options.publicOrigin) {
      this.#error(res, new TermavoxError(ErrorCode.Forbidden, 'forbidden origin'));
      return;
    }
    res.writeHead(204, {
      'access-control-allow-origin': this.#options.publicOrigin,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    res.end();
  }

  async #upload(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    // Checked before the token: a request from elsewhere does not spend it.
    if (req.headers.origin !== this.#options.publicOrigin) {
      this.#error(res, new TermavoxError(ErrorCode.Forbidden, 'forbidden origin'), { close: true });
      return;
    }
    const cors = { 'access-control-allow-origin': this.#options.publicOrigin, vary: 'Origin' };
    let use: Use;
    try {
      use = await this.#use(req, token, 'upload');
    } catch (err) {
      this.#error(res, fileError(err, this.#log), { close: true, headers: cors });
      return;
    }
    const { host, transfer, client, release } = use;
    const grant = use.grant as UploadGrant;
    try {
      const declared = req.headers['content-length'];
      if (declared !== undefined && Number(declared) !== grant.size) {
        throw new TermavoxError(ErrorCode.BadRequest, 'the upload is not the announced size');
      }
      const entry = await this.#receive(req, host, grant, transfer);
      this.#backend.auditTransfer(host, { userId: grant.userId, client }, 'file.upload', {
        path: grant.path,
        size: transfer.bytes,
      });
      transfer.finish({ state: 'done' });
      this.#json(res, 200, { entry }, cors);
    } catch (err) {
      transfer.finish(endOf(err));
      this.#error(res, fileError(err, this.#log), { close: true, headers: cors });
    } finally {
      release();
      this.#ended(transfer);
    }
  }

  /**
   * Writes the body to a temporary file next to the target (created exclusively), then puts it in
   * place. A file it replaces keeps its permission bits, and a new one gets the bits its request
   * asked for (the server's default without them). The temporary file has them from its first
   * byte: created with them and set exactly on its handle (the umask narrowed the open's), setuid
   * and setgid last (a write clears them). Whatever stops it first (the browser, an error,
   * `transfer.cancel`, a sign-out, 60 s without data), the handle is closed and the temporary file
   * removed, over the same channel: a lost connection, or a channel given up on a server that
   * stopped answering, leaves it behind.
   */
  async #receive(
    req: IncomingMessage,
    host: FileHost,
    grant: UploadGrant,
    transfer: ActiveTransfer,
  ): Promise<FileEntry> {
    const { signal } = transfer;
    // Each request before the bytes flow stops with the transfer: a server that never answers
    // holds neither the slot nor the browser.
    const sftp = await abortable(host.sftp(), signal);
    const kept = await abortable(keptMode(sftp, grant.path, grant.overwrite), signal);
    // A replaced file's bits win; the requested ones go to a new file (or over a dangling link).
    const mode = kept ?? grant.mode ?? null;
    const temp = joinPath(grant.dir, tempName(grant.name));
    // setuid and setgid wait for the complete content (a half-written set-id file never exists).
    const bits = mode === null ? undefined : mode & ~SET_ID_BITS;
    const handle = await abortable(sftp.open(temp, 'wx', bits), signal, (late) => {
      void this.#discard(sftp, late, temp);
    });
    const writer = new SftpFileWriter(sftp, handle, { onWritten: (n) => transfer.progress(n) });
    const idle = new IdleStop(
      this.#uploadIdleMs,
      () =>
        new TransferStop(
          { state: 'failed', code: ErrorCode.Cancelled },
          'the upload sent nothing for a minute',
        ),
    );
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, cb) {
        received += chunk.length;
        idle.touch();
        if (received > grant.size) {
          cb(new TermavoxError(ErrorCode.BadRequest, 'the upload is larger than announced'));
        } else {
          cb(null, chunk);
        }
      },
    });
    let open = true;
    let placed = false;
    try {
      if (bits !== undefined) await abortable(sftp.fchmod(handle, bits), signal);
      transfer.start(grant.size);
      try {
        await pipeline(req, counter, writer, {
          signal: AbortSignal.any([signal, idle.signal]),
        });
      } catch (err) {
        throw stopCause(err, [signal, idle.signal], () => !req.complete);
      }
      if (received !== grant.size) {
        throw new TermavoxError(ErrorCode.BadRequest, 'the upload is not the announced size');
      }
      transfer.progress(writer.written);
      if (mode !== null && (mode & SET_ID_BITS) !== 0) await sftp.fchmod(handle, mode);
      open = false;
      await sftp.close(handle);
      try {
        const target = { path: grant.path, parent: grant.dir, name: grant.name };
        await commitUpload(sftp, temp, target, grant.overwrite);
      } catch (err) {
        // The old file is already gone: the upload stays under its temporary name, never lost.
        if (isTermavoxError(err) && err.details?.keepTemp === true) placed = true;
        throw err;
      }
      placed = true;
      return await entryAt(sftp, grant.path, grant.name);
    } finally {
      idle.clear();
      // A pipeline that refused to start leaves the writer alive: stop it before the handle closes.
      if (!writer.destroyed) writer.destroy();
      if (open) await this.#closeQuietly(sftp, handle, writer.settled());
      if (!placed) await this.#removeTemp(sftp, temp);
    }
  }

  // ── download ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The single-use URL is the whole authorization: no page of another site can learn one, so
   * `Sec-Fetch-Site` is not checked (a development setup serves the app and the daemon from two
   * sites, `localhost` and `127.0.0.1`).
   */
  async #download(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    let use: Use;
    try {
      use = await this.#use(req, token, 'download');
    } catch (err) {
      this.#error(res, fileError(err, this.#log));
      return;
    }
    const { grant, host, transfer, client, release } = use;
    const { signal } = transfer;
    let sftp: SftpSession | null = null;
    let handle: SftpHandle | null = null;
    let reader: SftpFileReader | null = null;
    let idle: IdleStop | null = null;
    /** Known once the response started: from then on the audit row tells what it took. */
    let size: number | null = null;
    let sent = 0;
    try {
      // Each request before the bytes flow stops with the transfer: a server that never answers
      // holds neither the slot nor the browser.
      const session = await abortable(host.sftp(), signal);
      sftp = session;
      await abortable(downloadable(session, grant.path), signal);
      handle = await abortable(session.open(grant.path, 'r'), signal, (late) => {
        void this.#closeQuietly(session, late, undefined);
      });
      const attrs = await abortable(session.fstat(handle), signal);
      if (fileType(attrs.mode) !== 'file') {
        throw new TermavoxError(ErrorCode.NotFound, 'not a file');
      }
      // Stopped before a byte went out: an answer the browser can read, not a cut.
      signal.throwIfAborted();
      // The browser left while the file was opened: a pipeline into a closed response would
      // refuse without stopping the reader. Nothing in between awaits, so this check holds.
      if (res.destroyed) throw new TransferStop({ state: 'cancelled' }, 'the browser stopped it');
      // Exactly this many bytes are sent: a file growing meanwhile (a log) still ends cleanly.
      size = attrs.size;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'content-disposition': contentDisposition(
          grant.path.slice(grant.path.lastIndexOf('/') + 1),
        ),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
      });
      // The browser's download manager shows the download (and its size) before the first byte.
      res.flushHeaders();
      transfer.start(size);
      reader = new SftpFileReader(session, handle, size);
      // A response that takes nothing (a download paused for good, a client that never reads)
      // does not hold the transfer, its remote handle and the session's channel forever.
      const watch = new IdleStop(
        this.#downloadIdleMs,
        () =>
          new TransferStop(
            { state: 'failed', code: ErrorCode.Cancelled },
            'the download took nothing for two minutes',
          ),
      );
      idle = watch;
      // What the response accepted, not what the server answered: a bar never runs ahead.
      reader.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        watch.touch();
        transfer.progress(sent);
      });
      try {
        await pipeline(reader, res, { signal: AbortSignal.any([signal, watch.signal]) });
      } catch (err) {
        throw stopCause(err, [signal, watch.signal], () => !res.writableFinished);
      }
      transfer.finish({ state: 'done' });
    } catch (err) {
      transfer.finish(endOf(err));
      // Once the headers went out, cutting the response is the only honest failure.
      if (res.headersSent) res.destroy();
      else this.#error(res, fileError(err, this.#log));
    } finally {
      idle?.clear();
      if (size !== null) {
        this.#backend.auditTransfer(host, { userId: grant.userId, client }, 'file.download', {
          path: grant.path,
          size,
          bytes: sent,
          completed: transfer.state === 'done',
        });
      }
      // A reader still alive would go on reading a handle about to close: stop it first.
      if (reader && !reader.destroyed) reader.destroy();
      if (sftp && handle) await this.#closeQuietly(sftp, handle, reader?.settled());
      release();
      this.#ended(transfer);
    }
  }

  // ── shared ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Spends a URL and starts its transfer: the auth session must still be valid, file transfer on,
   * the session connected (and its runtime the grant's user's), and the user under the cap.
   */
  async #use(req: IncomingMessage, token: string, direction: TransferDirection): Promise<Use> {
    const { backend } = this.#options;
    const grant = TOKEN_PATTERN.test(token) ? backend.transfers.consume(token, direction) : null;
    if (!grant) throw new TermavoxError(ErrorCode.Forbidden, 'this transfer link is not valid');
    if (!(await this.#validSession(grant))) {
      throw new TermavoxError(ErrorCode.Forbidden, 'the sign-in behind this link ended');
    }
    if (!backend.settings().transferEnabled) {
      throw new TermavoxError(ErrorCode.FilesDisabled, 'file transfer is turned off');
    }
    const host = backend.fileHost(grant.sessionId);
    if (!host || host.userId !== grant.userId) {
      throw new TermavoxError(ErrorCode.SessionNotConnected, 'the session is not connected');
    }
    const transfer = backend.transfers.begin(grant);
    this.#watchAuthSessions();
    const release = backend.holdChannel(host);
    this.#log.info(
      { transferId: grant.transferId, direction, sessionId: grant.sessionId },
      'transfer started',
    );
    return { grant, host, transfer, client: this.#client(req), release };
  }

  /** Starts the revalidation of running transfers, unless it runs already. */
  #watchAuthSessions(): void {
    if (this.#revalidateTimer) return;
    this.#revalidateTimer = setInterval(() => void this.#revalidate(), this.#revalidateIntervalMs);
    this.#revalidateTimer.unref();
  }

  /**
   * One pass over the running transfers (plan §5.12): each auth session behind them is checked
   * once, and the transfers (and unused URLs) of one no longer valid stop, as after a revoke. A
   * check that fails is ridden out up to TRANSFER_REVALIDATE_MAX_FAILURES passes in a row. The
   * timer stops with the last transfer.
   */
  async #revalidate(): Promise<void> {
    if (this.#revalidating) return;
    const { transfers } = this.#backend;
    /** The auth sessions behind the running transfers, and their users. */
    const signIns = new Map<string, string>();
    for (const { grant } of transfers.running()) signIns.set(grant.authSessionId, grant.userId);
    if (signIns.size === 0) {
      if (this.#revalidateTimer) clearInterval(this.#revalidateTimer);
      this.#revalidateTimer = null;
      this.#revalidateFailures.clear();
      return;
    }
    for (const id of this.#revalidateFailures.keys()) {
      if (!signIns.has(id)) this.#revalidateFailures.delete(id);
    }
    this.#revalidating = true;
    try {
      for (const [authSessionId, userId] of signIns) {
        let valid: boolean;
        try {
          valid = await this.#options.authSessions.isValid(authSessionId, userId);
        } catch (err) {
          const failures = (this.#revalidateFailures.get(authSessionId) ?? 0) + 1;
          this.#log.warn({ err, failures }, 'transfer auth session revalidation failed');
          if (failures < TRANSFER_REVALIDATE_MAX_FAILURES) {
            this.#revalidateFailures.set(authSessionId, failures);
            continue;
          }
          valid = false;
        }
        this.#revalidateFailures.delete(authSessionId);
        if (!valid) transfers.revoke({ authSessionId });
      }
    } finally {
      this.#revalidating = false;
    }
  }

  async #validSession(grant: TransferGrant): Promise<boolean> {
    try {
      return await this.#options.authSessions.isValid(grant.authSessionId, grant.userId);
    } catch (err) {
      this.#log.warn({ err }, 'auth session validation failed');
      return false;
    }
  }

  /** The client by the WebSocket's rule: `X-Forwarded-For` only from a trusted proxy. */
  #client(req: IncomingMessage): AttachmentClient {
    return {
      ip: clientAddress(
        req.socket.remoteAddress,
        req.headers['x-forwarded-for'],
        this.#options.trustedProxies,
      ),
      userAgent: req.headers['user-agent']?.slice(0, MAX_USER_AGENT),
    };
  }

  /** An upload's temporary file goes (the upload failed or stopped before its commit). */
  async #removeTemp(sftp: SftpSession, temp: string): Promise<void> {
    await sftp.unlink(temp).catch((err: unknown) => {
      this.#log.warn({ err: describe(err) }, 'temporary upload file not removed');
    });
  }

  /** A temporary file the server opened only after its upload stopped: closed and removed. */
  async #discard(sftp: SftpSession, handle: SftpHandle, temp: string): Promise<void> {
    await this.#closeQuietly(sftp, handle, undefined);
    await this.#removeTemp(sftp, temp);
  }

  /** Closes a file once its requests settled (a close racing them would fail them). */
  async #closeQuietly(
    sftp: SftpSession,
    handle: SftpHandle,
    settled: Promise<void> | undefined,
  ): Promise<void> {
    await settled;
    await sftp.close(handle).catch((err: unknown) => {
      this.#log.info({ err: describe(err) }, 'transfer file handle not closed');
    });
  }

  #ended(transfer: ActiveTransfer): void {
    this.#log.info(
      { transferId: transfer.transferId, bytes: transfer.bytes, state: transfer.state },
      'transfer ended',
    );
  }

  #methodNotAllowed(res: ServerResponse, allow: string, close: boolean): void {
    this.#error(res, new TermavoxError(ErrorCode.BadRequest, 'method not allowed'), {
      status: 405,
      close,
      headers: { allow },
    });
  }

  #json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(text);
  }

  /**
   * `{ code, message }`. `close` for a request whose body may not have been read: the connection
   * ends with the answer instead of reading the rest of a large body.
   */
  #error(
    res: ServerResponse,
    err: TermavoxError,
    options: { status?: number; close?: boolean; headers?: Record<string, string> } = {},
  ): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    this.#json(
      res,
      options.status ?? STATUS[err.code] ?? 500,
      { code: err.code, message: err.message },
      { ...options.headers, ...(options.close ? { connection: 'close' } : {}) },
    );
  }
}

/**
 * Why a stream pipeline stopped: the abort reason of whoever stopped the transfer, the error of
 * the SFTP side or of our own checks, or the browser going away (`cancelled`).
 */
function stopCause(err: unknown, signals: AbortSignal[], browserLeft: () => boolean): unknown {
  for (const signal of signals) if (signal.aborted) return signal.reason;
  if (isTermavoxError(err) || err instanceof SftpError) return err;
  if (browserLeft()) return new TransferStop({ state: 'cancelled' }, 'the browser stopped it');
  return err;
}

/**
 * `promise`, or the abort reason as soon as `signal` aborts: a server sitting on a request does not
 * hold a stopped transfer. What it brings after the abort goes to `late` (a handle to close).
 */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      reject(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        if (stopped) late?.(value);
        else resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(err);
      },
    );
  });
}

/** Aborts its signal with `stop()` once `ms` pass without a `touch()`. */
class IdleStop {
  readonly #abort = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;

  constructor(ms: number, stop: () => TransferStop) {
    this.#timer = setTimeout(() => this.#abort.abort(stop()), ms);
    this.#timer.unref();
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  touch(): void {
    this.#timer.refresh();
  }

  clear(): void {
    clearTimeout(this.#timer);
  }
}

/** An error for the logs: its message may be a server's words (host text), cleaned first. */
function describe(err: unknown): { name?: string; message: string } {
  return err instanceof Error
    ? { name: err.name, message: hostText(err.message) }
    : { message: hostText(String(err)) };
}
