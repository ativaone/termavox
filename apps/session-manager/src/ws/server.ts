import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  type ClientMessage,
  CloseCode,
  decodeFrame,
  FrameType,
  NonceCache,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
  verifyTicket,
} from '@termdock/protocol';
import { ErrorCode } from '@termdock/shared';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { type Logger, silentLogger } from '../config/logger.ts';
import type { UserNotifier } from '../core/session-runtime.ts';
import type { OwnershipCheck } from '../core/types.ts';
import { WsAttachmentHandle } from './attachment-handle.ts';
import type { AuthSessionValidator, SessionGateway } from './types.ts';

export const WS_PATH = '/ws';
export const HELLO_TIMEOUT_MS = 5_000;
export const REVALIDATE_INTERVAL_MS = 60_000;
export const MAX_CHANNELS = 32;
export const MAX_PAYLOAD = 1024 * 1024;
const CLOSE_WAIT_MS = 2_000;

export interface WsServerOptions {
  host: string;
  port: number;
  /** Expected `Origin` header: the origin of TERMDOCK_PUBLIC_URL. */
  publicOrigin: string;
  /** TERMDOCK_WS_SECRET: HMAC key shared with the ticket issuer (web). */
  secret: Uint8Array;
  authSessions: AuthSessionValidator;
  ownership: OwnershipCheck;
  sessions: SessionGateway;
  logger?: Logger;
  /** Shared by every verifier in the process (single-use tickets). */
  nonces?: NonceCache;
  path?: string;
  helloTimeoutMs?: number;
  revalidateIntervalMs?: number;
  maxChannels?: number;
  maxPayload?: number;
  now?: () => number;
}

interface Binding {
  sessionId: string;
  handle: WsAttachmentHandle;
}

class Connection {
  readonly id = randomUUID();
  readonly ws: WebSocket;
  readonly ip: string | undefined;
  readonly channels = new Map<number, Binding>();
  userId: string | null = null;
  authSessionId: string | null = null;
  closing = false;
  queue: Promise<void> = Promise.resolve();
  helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ws: WebSocket, ip: string | undefined) {
    this.ws = ws;
    this.ip = ip;
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
}

/**
 * WebSocket protocol v1 server (plan §7): Origin check, ticket hello, auth-session
 * revalidation, channel multiplexing of attachments, and user-scoped broadcasts.
 */
export class WsServer implements UserNotifier {
  readonly #options: WsServerOptions;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #nonces: NonceCache;
  readonly #log: Logger;
  readonly #connections = new Set<Connection>();
  readonly #byUser = new Map<string, Set<Connection>>();
  #accepting = true;
  #revalidateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WsServerOptions) {
    this.#options = options;
    this.#nonces = options.nonces ?? new NonceCache();
    this.#log = (options.logger ?? silentLogger()).child({ component: 'ws' });
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayload ?? MAX_PAYLOAD,
    });
    this.#http = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' }).end('WebSocket only');
    });
    this.#http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
  }

  async listen(): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(this.#options.port, this.#options.host, () => {
        this.#http.off('error', reject);
        resolve();
      });
    });
    this.#revalidateTimer = setInterval(
      () => void this.#revalidate(),
      this.#options.revalidateIntervalMs ?? REVALIDATE_INTERVAL_MS,
    );
    this.#revalidateTimer.unref();
    return this.#http.address() as AddressInfo;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  sendToUser(userId: string, message: ServerMessage): void {
    const connections = this.#byUser.get(userId);
    if (!connections) return;
    for (const conn of connections) conn.send(message);
  }

  /**
   * Closes the connections of an auth session or a user with 4401 (internal API
   * `auth-sessions/revoke`). Returns how many were closed.
   */
  revoke(target: { authSessionId?: string; userId?: string }): number {
    let closed = 0;
    for (const conn of this.#connections) {
      if (!conn.userId) continue;
      const bySession = target.authSessionId && conn.authSessionId === target.authSessionId;
      const byUser = target.userId && conn.userId === target.userId;
      if (bySession || byUser) {
        this.#close(conn, CloseCode.Unauthenticated, 'revoked');
        closed++;
      }
    }
    return closed;
  }

  /** Graceful shutdown, step 1-2 (§5.8): stop accepting and tell clients to show "Restoring…". */
  beginShutdown(expectedBackInMs?: number): void {
    this.#accepting = false;
    const message: ServerMessage = {
      type: 'server.shutting_down',
      ...(expectedBackInMs !== undefined ? { expectedBackInMs } : {}),
    };
    for (const conn of this.#connections) if (conn.userId) conn.send(message);
  }

  /** Closes every connection (1001) and the listener. */
  async close(): Promise<void> {
    this.#accepting = false;
    if (this.#revalidateTimer) clearInterval(this.#revalidateTimer);
    this.#revalidateTimer = null;
    const closed = [...this.#connections].map(
      (conn) =>
        new Promise<void>((resolve) => {
          if (conn.ws.readyState === WebSocket.CLOSED) return resolve();
          conn.ws.once('close', () => resolve());
          this.#close(conn, 1001, 'server shutdown');
          setTimeout(() => {
            conn.ws.terminate();
            resolve();
          }, CLOSE_WAIT_MS).unref();
        }),
    );
    await Promise.all(closed);
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  // ── connection setup ────────────────────────────────────────────────────────

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== (this.#options.path ?? WS_PATH) || !this.#accepting) {
      const status = this.#accepting ? '404 Not Found' : '503 Service Unavailable';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      // A close code needs a completed handshake; nothing from this socket is processed.
      if (req.headers.origin !== this.#options.publicOrigin) {
        this.#log.info({ ip: req.socket.remoteAddress }, 'rejected origin');
        ws.close(CloseCode.Forbidden, 'forbidden origin');
        return;
      }
      this.#accept(ws, req.socket.remoteAddress);
    });
  }

  #accept(ws: WebSocket, ip: string | undefined): void {
    const conn = new Connection(ws, ip);
    this.#connections.add(conn);
    conn.helloTimer = setTimeout(
      () => this.#close(conn, CloseCode.Unauthenticated, 'hello timeout'),
      this.#options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    );
    ws.on('message', (data, isBinary) => {
      // One message at a time per connection, so an attach finishes before later input.
      conn.queue = conn.queue
        .then(() => this.#onMessage(conn, toBuffer(data), isBinary))
        .catch((err: unknown) => {
          this.#log.error({ err, connectionId: conn.id }, 'message handling failed');
          this.#close(conn, CloseCode.Internal, 'internal error');
        });
    });
    ws.on('error', (err) =>
      this.#log.info({ err: err.message, connectionId: conn.id }, 'ws error'),
    );
    ws.on('close', () => this.#cleanup(conn));
  }

  async #onMessage(conn: Connection, data: Buffer, isBinary: boolean): Promise<void> {
    if (conn.closing) return;
    if (!conn.userId) return this.#onHello(conn, data, isBinary);
    if (isBinary) return this.#onBinary(conn, data);
    let message: ClientMessage | null;
    try {
      message = parseClientMessage(data.toString('utf8'));
    } catch {
      this.#error(conn, ErrorCode.BadRequest, 'malformed message');
      return;
    }
    if (message) await this.#onControl(conn, message);
  }

  async #onHello(conn: Connection, data: Buffer, isBinary: boolean): Promise<void> {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    let message: ClientMessage | null = null;
    try {
      message = isBinary ? null : parseClientMessage(data.toString('utf8'));
    } catch {
      return this.#close(conn, CloseCode.BadRequest, 'malformed hello');
    }
    if (message?.type !== 'hello') {
      return this.#close(conn, CloseCode.Unauthenticated, 'hello expected');
    }
    if (message.protocol !== PROTOCOL_VERSION) {
      return this.#close(conn, CloseCode.ProtocolUnsupported, 'protocol version unsupported');
    }
    const now = this.#options.now?.() ?? Date.now();
    const verified = verifyTicket(this.#options.secret, message.ticket, this.#nonces, now);
    if (!verified.ok) {
      this.#log.info({ reason: verified.error, ip: conn.ip }, 'ticket rejected');
      return this.#close(conn, CloseCode.Unauthenticated, 'invalid ticket');
    }
    const { uid, asid } = verified.payload;
    if (!(await this.#isValid(asid, uid))) {
      return this.#close(conn, CloseCode.Unauthenticated, 'auth session invalid');
    }
    if (conn.closing) return;
    conn.userId = uid;
    conn.authSessionId = asid;
    let userConnections = this.#byUser.get(uid);
    if (!userConnections) {
      userConnections = new Set();
      this.#byUser.set(uid, userConnections);
    }
    userConnections.add(conn);
    this.#log.info({ connectionId: conn.id, userId: uid, ip: conn.ip }, 'connection authenticated');
    conn.send({ type: 'hello.ok', protocol: PROTOCOL_VERSION, userId: uid, serverTime: now });
    conn.send({ type: 'sessions.list', sessions: await this.#options.sessions.listForUser(uid) });
    for (const prompt of this.#options.sessions.pendingPrompts(uid)) conn.send(prompt);
  }

  // ── authenticated traffic ───────────────────────────────────────────────────

  async #onControl(conn: Connection, message: ClientMessage): Promise<void> {
    const userId = conn.userId!;
    const { sessions } = this.#options;
    switch (message.type) {
      case 'hello':
        this.#error(conn, ErrorCode.BadRequest, 'already authenticated');
        return;
      case 'session.attach':
        await this.#attach(conn, message.channel, message.sessionId, message.viewport);
        return;
      case 'session.detach':
        this.#detach(conn, message.channel);
        return;
      case 'terminal.viewport':
        this.#bound(conn, message.channel, (host, id) =>
          host.viewport(id, { cols: message.cols, rows: message.rows }),
        );
        return;
      case 'terminal.activate':
        this.#bound(conn, message.channel, (host, id) => host.activate(id));
        return;
      case 'terminal.resync':
        this.#bound(conn, message.channel, (host, id) => host.resync(id));
        return;
      case 'hostkey.decision': {
        if (!(await this.#owns(conn, message.sessionId))) return;
        const { sessionId, fingerprint, accept } = message;
        if (!(await sessions.hostKeyDecision(sessionId, fingerprint, accept, userId))) {
          this.#error(conn, ErrorCode.Conflict, 'no matching host-key prompt', { sessionId });
        }
        return;
      }
      case 'auth.response':
        if (!(await this.#owns(conn, message.sessionId))) return;
        // A stale promptId is discarded silently (§5.10). Answers are never logged.
        sessions.authResponse(message.sessionId, message.promptId, message.answers, userId);
        return;
      case 'ping':
        conn.send({ type: 'pong', t: message.t });
        return;
    }
  }

  async #attach(
    conn: Connection,
    channel: number,
    sessionId: string,
    viewport: { cols: number; rows: number },
  ): Promise<void> {
    if (conn.channels.has(channel)) {
      this.#error(conn, ErrorCode.BadRequest, 'channel already attached', { channel });
      return;
    }
    if (conn.channels.size >= (this.#options.maxChannels ?? MAX_CHANNELS)) {
      this.#close(conn, CloseCode.BadRequest, 'too many channels');
      return;
    }
    if (!(await this.#owns(conn, sessionId, channel))) return;
    const host = await this.#options.sessions.attachable(sessionId);
    if (conn.closing) return;
    if (!host) {
      this.#error(conn, ErrorCode.NotFound, 'session not found', { channel, sessionId });
      return;
    }
    const handle = new WsAttachmentHandle(randomUUID(), channel, conn.ws);
    conn.channels.set(channel, { sessionId, handle });
    host.attach(handle, viewport);
  }

  #detach(conn: Connection, channel: number): void {
    const binding = conn.channels.get(channel);
    if (!binding) return;
    conn.channels.delete(channel);
    binding.handle.close();
    this.#options.sessions.host(binding.sessionId)?.detach(binding.handle.id);
  }

  #onBinary(conn: Connection, data: Buffer): void {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(data);
    } catch {
      this.#error(conn, ErrorCode.BadRequest, 'malformed frame');
      return;
    }
    if (frame.type !== FrameType.Input) {
      this.#error(conn, ErrorCode.BadRequest, 'unexpected frame type');
      return;
    }
    // Input for a channel that is not attached (e.g. just detached) is dropped.
    const payload = frame.payload;
    this.#bound(conn, frame.channel, (host, id) => host.input(id, payload));
  }

  #bound(
    conn: Connection,
    channel: number,
    fn: (host: NonNullable<ReturnType<SessionGateway['host']>>, attachmentId: string) => void,
  ): void {
    const binding = conn.channels.get(channel);
    if (!binding) return;
    const host = this.#options.sessions.host(binding.sessionId);
    if (host) fn(host, binding.handle.id);
  }

  /** Ownership check; sends FORBIDDEN (without revealing whether the session exists). */
  async #owns(conn: Connection, sessionId: string, channel?: number): Promise<boolean> {
    const owner = await this.#options.ownership.sessionOwner(sessionId);
    if (owner !== null && owner === conn.userId) return true;
    this.#error(conn, ErrorCode.Forbidden, 'forbidden', {
      sessionId,
      ...(channel !== undefined ? { channel } : {}),
    });
    return false;
  }

  async #isValid(authSessionId: string, userId: string): Promise<boolean> {
    try {
      return await this.#options.authSessions.isValid(authSessionId, userId);
    } catch (err) {
      this.#log.warn({ err }, 'auth session validation failed');
      return false;
    }
  }

  async #revalidate(): Promise<void> {
    for (const conn of [...this.#connections]) {
      if (!conn.userId || !conn.authSessionId || conn.closing) continue;
      let valid: boolean;
      try {
        valid = await this.#options.authSessions.isValid(conn.authSessionId, conn.userId);
      } catch (err) {
        // A transient store error must not disconnect everyone; the next pass re-checks.
        this.#log.warn({ err }, 'auth session revalidation failed');
        continue;
      }
      if (!valid) this.#close(conn, CloseCode.Unauthenticated, 'auth session invalid');
    }
  }

  #error(
    conn: Connection,
    code: string,
    message: string,
    extra: { channel?: number; sessionId?: string } = {},
  ): void {
    conn.send({ type: 'error', code, message, ...extra });
  }

  #close(conn: Connection, code: number, reason: string): void {
    if (conn.closing) return;
    conn.closing = true;
    this.#cleanup(conn);
    conn.ws.close(code, reason);
  }

  #cleanup(conn: Connection): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    this.#connections.delete(conn);
    if (conn.userId) {
      const set = this.#byUser.get(conn.userId);
      set?.delete(conn);
      if (set?.size === 0) this.#byUser.delete(conn.userId);
    }
    for (const binding of conn.channels.values()) {
      binding.handle.close();
      this.#options.sessions.host(binding.sessionId)?.detach(binding.handle.id);
    }
    conn.channels.clear();
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
