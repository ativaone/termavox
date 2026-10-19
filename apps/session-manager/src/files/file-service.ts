import type { FileRequest, FileResult } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { type Logger, silentLogger } from '../config/logger.ts';
import type { FileHost } from '../core/types.ts';
import type { AuditInput, DaemonAuditType } from '../store/audit.ts';
import type { FileGateway, FileRequestContext, SessionGateway } from '../ws/types.ts';
import { fileError } from './errors.ts';
import { checkName, type NamedPath, namedPath, normalizePath } from './paths.ts';
import * as remote from './remote-fs.ts';
import { DEFAULT_FILE_SETTINGS, type FileSettings } from './settings.ts';

/** A session's SFTP channel closes after this long without requests or transfers (plan §5.12). */
export const SFTP_IDLE_CLOSE_MS = 5 * 60_000;
/** `files.progress` of a removal: at most four per second. */
export const PROGRESS_INTERVAL_MS = 250;
/** Paths a `file.remove` audit row keeps (a request may name up to 1 000). */
export const AUDIT_REMOVE_PATHS = 20;

export interface FileServiceOptions {
  sessions: Pick<SessionGateway, 'fileHost'>;
  /** The instance settings, cached by the caller (`cachedFileSettings`). Default: on, no audit. */
  settings?: () => FileSettings;
  /** Writes one audit row (fire-and-forget); only called while `file_audit_enabled` is on. */
  audit?: (input: AuditInput) => void;
  logger?: Logger;
  /** Default SFTP_IDLE_CLOSE_MS (tests). */
  idleCloseMs?: number;
  now?: () => number;
}

type FileAuditType = Extract<DaemonAuditType, `file.${string}`>;

/** A request whose names and paths were checked before anything reaches the server. */
type CheckedRequest =
  | { op: 'open' }
  | { op: 'list'; path: string }
  | { op: 'mkdir'; target: NamedPath }
  | { op: 'rename'; from: NamedPath; to: NamedPath }
  | { op: 'remove'; targets: NamedPath[] }
  | { op: 'upload'; request: Extract<FileRequest, { op: 'upload' }> }
  | { op: 'download'; request: Extract<FileRequest, { op: 'download' }> };

/** Users of one session's SFTP channel, and the timer that closes it once there are none. */
interface ChannelUse {
  host: FileHost;
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The file panel's requests (plan §5.12): gates them on the instance setting, finds the session's
 * live runtime, checks names, runs the operation over the session's SFTP channel, writes the audit
 * row when the audit is on, and closes a channel nobody used for a while.
 */
export class FileService implements FileGateway {
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
  }

  async handle(context: FileRequestContext, request: FileRequest): Promise<FileResult> {
    try {
      if (!this.#settings().transferEnabled) {
        throw new TermdockError(ErrorCode.FilesDisabled, 'file transfer is turned off');
      }
      const checked = checkRequest(request);
      const host = this.#options.sessions.fileHost(context.sessionId);
      if (!host) {
        throw new TermdockError(ErrorCode.SessionNotConnected, 'the session is not connected');
      }
      // The connection's ownership check already passed; the runtime must agree.
      if (host.userId !== context.userId) throw new TermdockError(ErrorCode.Forbidden, 'forbidden');
      if (context.signal.aborted) throw new TermdockError(ErrorCode.Cancelled, 'cancelled');
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

  /** Part 2 (transfers) stops a transfer here; nothing can be running before it lands. */
  cancelTransfer(_userId: string, _transferId: string): void {}

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

  /** Daemon shutdown: idle timers stop (the runtimes close their connections themselves). */
  close(): void {
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
        const entry = await remote.makeFolder(await host.sftp(), checked.target);
        this.#audit(host, context, 'file.mkdir', { path: checked.target.path });
        return { op: 'mkdir', entry };
      }
      case 'rename': {
        const entry = await remote.rename(await host.sftp(), checked.from, checked.to);
        this.#audit(host, context, 'file.rename', { from: checked.from.path, to: checked.to.path });
        return { op: 'rename', entry };
      }
      case 'remove':
        return { op: 'remove', removed: await this.#remove(host, context, checked.targets) };
      case 'upload':
      case 'download':
        return this.#mintTransfer(host, context, checked.request);
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
  ): Promise<number> {
    const sftp = await host.sftp();
    let removed = 0;
    let sentAt = this.#now();
    try {
      return await remote.remove(sftp, targets, {
        signal: context.signal,
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
   * Upload and download URLs (plan §5.12 "Transfers"): part 2 replaces this function with the one
   * that mints them.
   */
  async #mintTransfer(
    _host: FileHost,
    _context: FileRequestContext,
    _request: Extract<FileRequest, { op: 'upload' | 'download' }>,
  ): Promise<FileResult> {
    throw new TermdockError(ErrorCode.Internal, 'transfers not implemented yet');
  }

  /** One `file.*` audit row with the client's address, while `file_audit_enabled` is on. */
  #audit(
    host: FileHost,
    context: FileRequestContext,
    type: FileAuditType,
    detail: Record<string, unknown>,
  ): void {
    const sink = this.#options.audit;
    if (!sink || !this.#settings().auditEnabled) return;
    try {
      sink({
        type,
        actorUserId: context.userId,
        targetType: 'session',
        targetId: host.sessionId,
        detail: { serverId: host.serverId, ...detail },
        ...(context.client.ip ? { ip: context.client.ip } : {}),
        ...(context.client.userAgent ? { userAgent: context.client.userAgent } : {}),
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
      return { op: 'mkdir', target: namedPath(request.path) };
    case 'rename':
      return { op: 'rename', from: namedPath(request.from), to: namedPath(request.to) };
    case 'remove':
      return { op: 'remove', targets: request.paths.map(namedPath) };
    case 'upload':
      checkName(request.name);
      return { op: 'upload', request };
    case 'download':
      namedPath(request.path);
      return { op: 'download', request };
  }
}
