import { type FileRequest, type FileResult, TRANSFER_PATH } from '@termavox/protocol';
import { ErrorCode, TermavoxError } from '@termavox/shared';
import { type Logger, silentLogger } from '../config/logger.ts';
import type { AttachmentClient, FileHost } from '../core/types.ts';
import type { AuditInput, DaemonAuditType } from '../store/audit.ts';
import type { FileGateway, FileRequestContext, SessionGateway } from '../ws/types.ts';
import { fileError } from './errors.ts';
import { checkName, type NamedPath, namedPath, normalizePath } from './paths.ts';
import * as remote from './remote-fs.ts';
import { DEFAULT_FILE_SETTINGS, type FileSettings } from './settings.ts';
import { downloadable, uploadTarget } from './transfer-fs.ts';
import type { TransferAuditDetail, TransferBackend } from './transfer-routes.ts';
import { PROGRESS_INTERVAL_MS, Transfers } from './transfers.ts';

export { PROGRESS_INTERVAL_MS } from './transfers.ts';

/** A session's SFTP channel closes after this long without requests or transfers (plan §5.12). */
export const SFTP_IDLE_CLOSE_MS = 5 * 60_000;
/** Paths a `file.remove` audit row keeps (a request may name up to 1 000). */
export const AUDIT_REMOVE_PATHS = 20;
/** At shutdown, running transfers get this long to clean up after themselves (temporary files). */
export const TRANSFER_DRAIN_MS = 3_000;

export interface FileServiceOptions {
  sessions: Pick<SessionGateway, 'fileHost'>;
  /** The instance settings, cached by the caller (`cachedFileSettings`). Default: on, no audit. */
  settings?: () => FileSettings;
  /** Writes one audit row (fire-and-forget); only called while `file_audit_enabled` is on. */
  audit?: (input: AuditInput) => void;
  logger?: Logger;
  /** Default SFTP_IDLE_CLOSE_MS (tests). */
  idleCloseMs?: number;
  /** The transfers and their URLs; default: a fresh registry. */
  transfers?: Transfers;
  now?: () => number;
}

type FileAuditType = Extract<DaemonAuditType, `file.${string}`>;
/** Who an audit row names: the acting user and the client that did it. */
interface Actor {
  userId: string;
  client: AttachmentClient;
}

/** A request whose names and paths were checked before anything reaches the server. */
type CheckedRequest =
  | { op: 'open' }
  | { op: 'list'; path: string }
  | { op: 'mkdir'; target: NamedPath; mode?: number }
  | { op: 'rename'; from: NamedPath; to: NamedPath }
  | { op: 'remove'; targets: NamedPath[]; filesOnly: boolean }
  | { op: 'upload'; dir: string; name: string; size: number; overwrite: boolean; mode?: number }
  | { op: 'download'; target: NamedPath };

/** Users of one session's SFTP channel, and the timer that closes it once there are none. */
interface ChannelUse {
  host: FileHost;
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The file panel's requests (plan §5.12): gates them on the instance setting, finds the session's
 * live runtime, checks names, runs the operation over the session's SFTP channel, writes the audit
 * row when the audit is on, and closes a channel nobody used for a while. Uploads and downloads
 * get a single-use URL here; the transfer routes (the backend below) move their bytes.
 */
export class FileService implements FileGateway, TransferBackend {
  readonly transfers: Transfers;
  readonly #options: FileServiceOptions;
  readonly #settings: () => FileSettings;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #idleCloseMs: number;
  readonly #channels = new Map<string, ChannelUse>();

  constructor(options: FileServiceOptions) {
    this.#options = options;
    this.#settings = options.settings ?? (() => DEFAULT_FILE_SETTINGS);
    this.#log = (options.logger ?? silentLogger()).child({ component: 'files' });
    this.#now = options.now ?? Date.now;
    this.#idleCloseMs = options.idleCloseMs ?? SFTP_IDLE_CLOSE_MS;
    this.transfers = options.transfers ?? new Transfers({ now: this.#now });
  }

  /** The routes that move the transfers' bytes use this service (WsServer mounts them). */
  get transferBackend(): TransferBackend {
    return this;
  }

  // ── TransferBackend ─────────────────────────────────────────────────────────────────────────

  settings(): FileSettings {
    return this.#settings();
  }

  fileHost(sessionId: string): FileHost | undefined {
    return this.#options.sessions.fileHost(sessionId);
  }

  auditTransfer(
    host: FileHost,
    actor: Actor,
    type: 'file.upload' | 'file.download',
    detail: TransferAuditDetail,
  ): void {
    this.#audit(host, actor, type, detail);
  }

  async handle(context: FileRequestContext, request: FileRequest): Promise<FileResult> {
    try {
      if (!this.#settings().transferEnabled) {
        throw new TermavoxError(ErrorCode.FilesDisabled, 'file transfer is turned off');
      }
      const checked = checkRequest(request);
      const host = this.#options.sessions.fileHost(context.sessionId);
      if (!host) {
        throw new TermavoxError(ErrorCode.SessionNotConnected, 'the session is not connected');
      }
      // The connection's ownership check already passed; the runtime must agree.
      if (host.userId !== context.userId) throw new TermavoxError(ErrorCode.Forbidden, 'forbidden');
      if (context.signal.aborted) throw new TermavoxError(ErrorCode.Cancelled, 'cancelled');
      const release = this.holdChannel(host);
      try {
        return await this.#run(host, context, checked);
      } finally {
        release();
      }
    } catch (err) {
      throw fileError(err, this.#log);
    }
  }

  cancelTransfer(userId: string, transferId: string): void {
    this.transfers.cancel(userId, transferId);
  }

  revokeTransfers(target: { userId?: string; authSessionId?: string }): void {
    this.transfers.revoke(target);
  }

  /**
   * Keeps a session's SFTP channel from the idle close while a request (or, part 2, a transfer)
   * uses it. Call the returned function once, when that use ends: the channel then closes after
   * `idleCloseMs` unless something uses it again.
   */
  holdChannel(host: FileHost): () => void {
    let use = this.#channels.get(host.sessionId);
    if (!use || use.host !== host) {
      // A replaced runtime: its connection, and so its channel, are gone with it.
      if (use?.timer) clearTimeout(use.timer);
      use = { host, users: 0, timer: null };
      this.#channels.set(host.sessionId, use);
    }
    const current = use;
    current.users++;
    if (current.timer) clearTimeout(current.timer);
    current.timer = null;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      current.users--;
      if (current.users > 0 || this.#channels.get(host.sessionId) !== current) return;
      current.timer = setTimeout(() => {
        if (current.users > 0 || this.#channels.get(host.sessionId) !== current) return;
        this.#channels.delete(host.sessionId);
        current.host.closeSftp();
      }, this.#idleCloseMs);
      current.timer.unref();
    };
  }

  /**
   * Daemon shutdown: transfers stop (each gets a moment to remove its temporary file) and idle
   * timers stop (the runtimes close their connections themselves).
   */
  async close(): Promise<void> {
    this.transfers.close();
    await this.transfers.drained(TRANSFER_DRAIN_MS);
    for (const use of this.#channels.values()) if (use.timer) clearTimeout(use.timer);
    this.#channels.clear();
  }

  async #run(
    host: FileHost,
    context: FileRequestContext,
    checked: CheckedRequest,
  ): Promise<FileResult> {
    const { signal } = context;
    switch (checked.op) {
      case 'open': {
        const home = await remote.home(await host.sftp());
        return { op: 'open', home, cwd: await host.currentDirectory() };
      }
      case 'list':
        return { op: 'list', ...(await remote.list(await host.sftp(), checked.path, { signal })) };
      case 'mkdir': {
        const entry = await remote.makeFolder(await host.sftp(), checked.target, checked.mode);
        this.#audit(host, context, 'file.mkdir', { path: checked.target.path });
        return { op: 'mkdir', entry };
      }
      case 'rename': {
        const entry = await remote.rename(await host.sftp(), checked.from, checked.to);
        this.#audit(host, context, 'file.rename', { from: checked.from.path, to: checked.to.path });
        return { op: 'rename', entry };
      }
      case 'remove': {
        const removed = await this.#remove(host, context, checked.targets, checked.filesOnly);
        return { op: 'remove', removed };
      }
      case 'upload':
      case 'download':
        return this.#mintTransfer(host, context, checked);
    }
  }

  /**
   * Even a removal that failed or was cancelled half-way is audited with what it removed: those
   * entries are gone.
   */
  async #remove(
    host: FileHost,
    context: FileRequestContext,
    targets: NamedPath[],
    filesOnly: boolean,
  ): Promise<number> {
    const sftp = await host.sftp();
    let removed = 0;
    let sentAt = this.#now();
    try {
      return await remote.remove(sftp, targets, {
        signal: context.signal,
        filesOnly,
        onProgress: (count) => {
          removed = count;
          const at = this.#now();
          if (at - sentAt < PROGRESS_INTERVAL_MS) return;
          sentAt = at;
          context.send({ type: 'files.progress', requestId: context.requestId, removed: count });
        },
      });
    } finally {
      if (removed > 0) {
        this.#audit(host, context, 'file.remove', {
          paths: targets.slice(0, AUDIT_REMOVE_PATHS).map((target) => target.path),
          removed,
        });
      }
    }
  }

  /**
   * Upload and download URLs (plan §5.12 "Transfers"): the target is checked now (an upload's
   * folder and name, a download's file), then a single-use URL bound to this user, auth session,
   * session and path is minted. Its progress goes to the connection that asked.
   */
  async #mintTransfer(
    host: FileHost,
    context: FileRequestContext,
    checked: Extract<CheckedRequest, { op: 'upload' | 'download' }>,
  ): Promise<FileResult> {
    const sftp = await host.sftp();
    const bound = {
      userId: context.userId,
      authSessionId: context.authSessionId,
      sessionId: host.sessionId,
      notify: context.send,
      client: context.client,
    };
    if (checked.op === 'upload') {
      const target = await uploadTarget(sftp, checked.dir, checked.name, checked.overwrite);
      const { token, grant } = this.transfers.mint({
        ...bound,
        direction: 'upload',
        dir: target.parent,
        name: target.name,
        path: target.path,
        overwrite: checked.overwrite,
        ...(checked.mode !== undefined ? { mode: checked.mode } : {}),
        size: checked.size,
      });
      return {
        op: 'upload',
        transferId: grant.transferId,
        url: `${TRANSFER_PATH}/upload/${token}`,
      };
    }
    const { size } = await downloadable(sftp, checked.target.path);
    const { token, grant } = this.transfers.mint({
      ...bound,
      direction: 'download',
      path: checked.target.path,
      size,
    });
    return {
      op: 'download',
      transferId: grant.transferId,
      url: `${TRANSFER_PATH}/download/${token}`,
      name: checked.target.name,
      size,
    };
  }

  /** One `file.*` audit row with the client's address, while `file_audit_enabled` is on. */
  #audit(host: FileHost, actor: Actor, type: FileAuditType, detail: Record<string, unknown>): void {
    const sink = this.#options.audit;
    if (!sink || !this.#settings().auditEnabled) return;
    try {
      sink({
        type,
        actorUserId: actor.userId,
        targetType: 'session',
        targetId: host.sessionId,
        detail: { serverId: host.serverId, ...detail },
        ...(actor.client.ip ? { ip: actor.client.ip } : {}),
        ...(actor.client.userAgent ? { userAgent: actor.client.userAgent } : {}),
        at: this.#now(),
      });
    } catch (err) {
      this.#log.warn({ err, type }, 'file audit row not written');
    }
  }
}

/** NAME_INVALID for a name that cannot name an entry, before anything reaches the server. */
function checkRequest(request: FileRequest): CheckedRequest {
  switch (request.op) {
    case 'open':
      return { op: 'open' };
    case 'list':
      return { op: 'list', path: normalizePath(request.path) };
    case 'mkdir':
      return {
        op: 'mkdir',
        target: namedPath(request.path),
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
      };
    case 'rename':
      return { op: 'rename', from: namedPath(request.from), to: namedPath(request.to) };
    case 'remove':
      return {
        op: 'remove',
        targets: request.paths.map(namedPath),
        filesOnly: request.filesOnly === true,
      };
    case 'upload':
      checkName(request.name);
      return {
        op: 'upload',
        dir: normalizePath(request.dir),
        name: request.name,
        size: request.size,
        overwrite: request.overwrite,
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
      };
    case 'download':
      return { op: 'download', target: namedPath(request.path) };
  }
}
