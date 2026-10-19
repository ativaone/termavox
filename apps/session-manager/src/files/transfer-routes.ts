import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type FileEntry, TRANSFER_PATH } from '@termdock/protocol';
import { ErrorCode, isTermdockError, TermdockError } from '@termdock/shared';
import { type Logger, silentLogger } from '../config/logger.ts';
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
import { commitUpload, downloadable, tempName } from './transfer-fs.ts';
import { TOKEN_PATTERN, type TransferDirection, type TransferGrant } from './transfer-tokens.ts';
import { type ActiveTransfer, endOf, TransferStop, type Transfers } from './transfers.ts';

/** An upload that sends nothing for this long is stopped (plan §5.12 "Limits"). */
export const UPLOAD_IDLE_TIMEOUT_MS = 60_000;
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
  /** A `file.upload` / `file.download` row, while the file audit is on. */
  auditTransfer(
    host: FileHost,
    actor: { userId: string; client: AttachmentClient },
    type: 'file.upload' | 'file.download',
    detail: { path: string; size: number },
  ): void;
}

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
 * transfers.
 */
export class TransferRoutes {
  readonly #options: TransferRoutesOptions;
  readonly #backend: TransferBackend;
  readonly #log: Logger;
  readonly #uploadIdleMs: number;

  constructor(options: TransferRoutesOptions) {
    this.#options = options;
    this.#backend = options.backend;
    this.#log = (options.logger ?? silentLogger()).child({ component: 'transfers' });
    this.#uploadIdleMs = options.uploadIdleMs ?? UPLOAD_IDLE_TIMEOUT_MS;
  }

  /** The paths these routes answer: everything under TRANSFER_PATH. */
  static owns(pathname: string): boolean {
    return pathname === TRANSFER_PATH || pathname.startsWith(`${TRANSFER_PATH}/`);
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    this.#route(req, res).catch((err: unknown) => {
      this.#log.error({ err }, 'transfer route failed');
      this.#error(res, new TermdockError(ErrorCode.Internal, 'internal error'), { close: true });
    });
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = ROUTE.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
    const close = req.method === 'POST';
    if (!match) {
      this.#error(res, new TermdockError(ErrorCode.NotFound, 'not found'), { close });
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
      this.#error(res, new TermdockError(ErrorCode.Forbidden, 'forbidden origin'));
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
      this.#error(res, new TermdockError(ErrorCode.Forbidden, 'forbidden origin'), { close: true });
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
        throw new TermdockError(ErrorCode.BadRequest, 'the upload is not the announced size');
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
   * place. Whatever stops it first (the browser, an error, `transfer.cancel`, a sign-out, 60 s
   * without data), the handle is closed and the temporary file removed: no partial file is left.
   */
  async #receive(
    req: IncomingMessage,
    host: FileHost,
    grant: UploadGrant,
    transfer: ActiveTransfer,
  ): Promise<FileEntry> {
    const sftp = await host.sftp();
    transfer.signal.throwIfAborted();
    const temp = joinPath(grant.dir, tempName(grant.name));
    const handle = await sftp.open(temp, 'wx');
    const writer = new SftpFileWriter(sftp, handle, { onWritten: (n) => transfer.progress(n) });
    const idle = new AbortController();
    const timer = setTimeout(
      () =>
        idle.abort(
          new TransferStop(
            { state: 'failed', code: ErrorCode.Cancelled },
            'the upload sent nothing for a minute',
          ),
        ),
      this.#uploadIdleMs,
    );
    timer.unref();
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, cb) {
        received += chunk.length;
        timer.refresh();
        if (received > grant.size) {
          cb(new TermdockError(ErrorCode.BadRequest, 'the upload is larger than announced'));
        } else {
          cb(null, chunk);
        }
      },
    });
    let open = true;
    let placed = false;
    try {
      transfer.start(grant.size);
      try {
        await pipeline(req, counter, writer, {
          signal: AbortSignal.any([transfer.signal, idle.signal]),
        });
      } catch (err) {
        throw stopCause(err, [transfer.signal, idle.signal], () => !req.complete);
      }
      if (received !== grant.size) {
        throw new TermdockError(ErrorCode.BadRequest, 'the upload is not the announced size');
      }
      transfer.progress(writer.written);
      open = false;
      await sftp.close(handle);
      try {
        const target = { path: grant.path, parent: grant.dir, name: grant.name };
        await commitUpload(sftp, temp, target, grant.overwrite);
      } catch (err) {
        // The old file is already gone: the upload stays under its temporary name, never lost.
        if (isTermdockError(err) && err.details?.keepTemp === true) placed = true;
        throw err;
      }
      placed = true;
      return await entryAt(sftp, grant.path, grant.name);
    } finally {
      clearTimeout(timer);
      // A pipeline that refused to start leaves the writer alive: stop it before the handle closes.
      if (!writer.destroyed) writer.destroy();
      if (open) await this.#closeQuietly(sftp, handle, writer.settled());
      if (!placed) {
        await sftp.unlink(temp).catch((err: unknown) => {
          this.#log.warn({ err: describe(err) }, 'temporary upload file not removed');
        });
      }
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
    let sftp: SftpSession | null = null;
    let handle: SftpHandle | null = null;
    let reader: SftpFileReader | null = null;
    try {
      const { signal } = transfer;
      sftp = await host.sftp();
      await downloadable(sftp, grant.path);
      signal.throwIfAborted();
      handle = await sftp.open(grant.path, 'r');
      const attrs = await sftp.fstat(handle);
      if (fileType(attrs.mode) !== 'file') {
        throw new TermdockError(ErrorCode.NotFound, 'not a file');
      }
      // Stopped before a byte went out: an answer the browser can read, not a cut.
      signal.throwIfAborted();
      // The browser left while the file was opened: a pipeline into a closed response would
      // refuse without stopping the reader. Nothing in between awaits, so this check holds.
      if (res.destroyed) throw new TransferStop({ state: 'cancelled' }, 'the browser stopped it');
      // Exactly this many bytes are sent: a file growing meanwhile (a log) still ends cleanly.
      const size = attrs.size;
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
      });
      // The browser's download manager shows the download (and its size) before the first byte.
      res.flushHeaders();
      this.#backend.auditTransfer(host, { userId: grant.userId, client }, 'file.download', {
        path: grant.path,
        size,
      });
      transfer.start(size);
      reader = new SftpFileReader(sftp, handle, size);
      let sent = 0;
      // What the response accepted, not what the server answered: a bar never runs ahead.
      reader.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        transfer.progress(sent);
      });
      try {
        await pipeline(reader, res, { signal: transfer.signal });
      } catch (err) {
        throw stopCause(err, [transfer.signal], () => !res.writableFinished);
      }
      transfer.finish({ state: 'done' });
    } catch (err) {
      transfer.finish(endOf(err));
      // Once the headers went out, cutting the response is the only honest failure.
      if (res.headersSent) res.destroy();
      else this.#error(res, fileError(err, this.#log));
    } finally {
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
    if (!grant) throw new TermdockError(ErrorCode.Forbidden, 'this transfer link is not valid');
    if (!(await this.#validSession(grant))) {
      throw new TermdockError(ErrorCode.Forbidden, 'the sign-in behind this link ended');
    }
    if (!backend.settings().transferEnabled) {
      throw new TermdockError(ErrorCode.FilesDisabled, 'file transfer is turned off');
    }
    const host = backend.fileHost(grant.sessionId);
    if (!host || host.userId !== grant.userId) {
      throw new TermdockError(ErrorCode.SessionNotConnected, 'the session is not connected');
    }
    const transfer = backend.transfers.begin(grant);
    const release = backend.holdChannel(host);
    this.#log.info(
      { transferId: grant.transferId, direction, sessionId: grant.sessionId },
      'transfer started',
    );
    return { grant, host, transfer, client: this.#client(req), release };
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
    this.#error(res, new TermdockError(ErrorCode.BadRequest, 'method not allowed'), {
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
    err: TermdockError,
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
  if (isTermdockError(err) || err instanceof SftpError) return err;
  if (browserLeft()) return new TransferStop({ state: 'cancelled' }, 'the browser stopped it');
  return err;
}

function describe(err: unknown): { name?: string; message: string } {
  return err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) };
}
