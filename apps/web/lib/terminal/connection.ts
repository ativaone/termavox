import {
  type ClientMessage,
  CloseCode,
  decodeFrame,
  type FileRequest,
  type FileResultOf,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ServerMessage,
  type SessionSummary,
} from '@termavox/protocol/client';
import {
  type FileApi,
  type FileRequestOptions,
  FileRequests,
  type TransferListener,
} from '../files/requests.ts';
import { type ChannelHost, TerminalChannel, type TerminalChannelOptions } from './channel.ts';
import { fetchWsTicket, resolveWsUrl, TicketRequestError } from './config.ts';
import { Store } from './store.ts';
import type { TicketFetcher, WebSocketFactory, WebSocketLike } from './types.ts';

export const PING_INTERVAL_MS = 25_000;
/** Server limit per connection (plan §7.1). */
export const MAX_CHANNELS = 32;
const MAX_CHANNEL_ID = 0xffff_ffff;
const OPEN = 1; // WebSocket.OPEN

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  /** Relative jitter: 0.2 = ±20 %. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 30_000, jitter: 0.2 };
/**
 * Shortest wait after a 4429 close (too many connections for this user): the next attempt is
 * refused the same way until the user closes another window, so it never retries sooner.
 */
export const RATE_LIMITED_RETRY_MS = 10_000;

/** Delay before reconnect attempt `attempt` (1-based): 1 s, 2 s, 4 s … capped, with jitter. */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(options.maxMs, options.initialMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(0, Math.round(base * (1 + options.jitter * (2 * random() - 1))));
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Non-retryable failures; the connection stays closed until `connect()` is called again. */
export type ConnectionErrorKind = 'unauthenticated' | 'forbidden' | 'protocol_unsupported';

export interface ConnectionError {
  kind: ConnectionErrorKind;
  /** WebSocket close code (4401/4403/4409) or the ticket endpoint's HTTP status (401/403). */
  code: number;
}

export type HostKeyPrompt = Extract<ServerMessage, { type: 'hostkey.prompt' }>;
export type AuthPromptRequest = Extract<ServerMessage, { type: 'auth.prompt' }>;
export type ServerError = Extract<ServerMessage, { type: 'error' }>;
/** Termavox tmux servers a session's connection found that this installation does not run. */
export type RemoteSessionsNotice = Omit<
  Extract<ServerMessage, { type: 'server.remote_sessions' }>,
  'type'
>;

export interface SessionEntry extends SessionSummary {
  /**
   * `detail` of the latest `session.status` (failure code, notice, end reason …); a list or
   * upsert sets it from the summary's `statusDetail`, so it survives a reload.
   */
  detail: string | null;
  /** `retryInMs` of the latest status, received at `statusAt` (client clock), for countdowns. */
  retryInMs: number | null;
  statusAt: number | null;
  /**
   * Progress of the retry round in progress (plan D-31), from the latest status: `attempt` of
   * `maxAttempts` for a session that never connected, `retryUntil` (epoch ms, server clock) for
   * one that lost its connection. Null outside a round, or before a status of it arrived.
   */
  attempt: number | null;
  maxAttempts: number | null;
  retryUntil: number | null;
  /** Latched when a status carried `detail: 'remote_rebooted'`; see acknowledgeRemoteReboot. */
  remoteRebooted: boolean;
  /**
   * The session ended but its tmux on the server could not be ended yet (`session.status` with
   * `remoteCleanup: 'pending'`, plan D-30); the next connection to that server ends it. Live only:
   * not in the summary, so kept from the previous entry while the tab lives, until the session
   * leaves `ended` (reopened).
   */
  remoteCleanup: boolean;
}

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly error: ConnectionError | null;
  /** Consecutive failed attempts since the last `hello.ok`. */
  readonly attempt: number;
  /** When the next attempt starts (epoch ms) while `reconnecting`. */
  readonly retryAt: number | null;
  /**
   * Close code of the socket that dropped last (4429: too many Termavox windows for this user);
   * null once a connection is accepted again (`hello.ok`) or after `close()`.
   */
  readonly closeCode: number | null;
  readonly userId: string | null;
  /** True once a `sessions.list` arrived (stays true across reconnects). */
  readonly sessionsLoaded: boolean;
  readonly sessions: readonly SessionEntry[];
  /** Pending host-key decisions by session id (replayed by the server on every connection). */
  readonly hostKeyPrompts: Readonly<Record<string, HostKeyPrompt>>;
  /** Pending keyboard-interactive prompts by session id. */
  readonly authPrompts: Readonly<Record<string, AuthPromptRequest>>;
  /** Set by `server.shutting_down` until the next `hello.ok` (show "Restoring…"). */
  readonly shuttingDown: { expectedBackInMs: number | null } | null;
  /** The latest `error` message not scoped to a channel (e.g. a refused host-key decision). */
  readonly lastError: ServerError | null;
  /**
   * `server.remote_sessions` (plan D-30), one notice per server in arrival order; a newer message
   * for a server already shown updates it. Dismissed servers stay quiet while the tab lives.
   */
  readonly remoteSessions: readonly RemoteSessionsNotice[];
}

export interface TermavoxConnectionOptions {
  /** Default: NEXT_PUBLIC_TERMAVOX_WS_URL, else same-origin `/ws`. */
  url?: string;
  /** Default: `POST /api/ws/ticket` on the same origin. */
  fetchTicket?: TicketFetcher;
  /** Default: the browser `WebSocket`. */
  createWebSocket?: WebSocketFactory;
  pingIntervalMs?: number;
  backoff?: Partial<BackoffOptions>;
  maxChannels?: number;
  random?: () => number;
  now?: () => number;
  /** How long a file request may wait for its answer (default 30 s, plan §5.12). */
  fileRequestTimeoutMs?: number;
}

export class ChannelLimitError extends Error {
  constructor(max: number) {
    super(`at most ${max} terminal channels per connection`);
    this.name = 'ChannelLimitError';
  }
}

const FATAL_CLOSE: ReadonlyMap<number, ConnectionErrorKind> = new Map([
  [CloseCode.Unauthenticated, 'unauthenticated'],
  [CloseCode.Forbidden, 'forbidden'],
  [CloseCode.ProtocolUnsupported, 'protocol_unsupported'],
]);

const INITIAL_STATE: ConnectionState = {
  status: 'idle',
  error: null,
  attempt: 0,
  retryAt: null,
  closeCode: null,
  userId: null,
  sessionsLoaded: false,
  sessions: [],
  hostKeyPrompts: {},
  authPrompts: {},
  shuttingDown: null,
  lastError: null,
  remoteSessions: [],
};

function toEntry(summary: SessionSummary, previous?: SessionEntry): SessionEntry {
  return {
    ...summary,
    // The summary is built when it is sent: its detail is as fresh as the latest status.
    detail: summary.statusDetail,
    retryInMs: previous?.retryInMs ?? null,
    statusAt: previous?.statusAt ?? null,
    attempt: previous?.attempt ?? null,
    maxAttempts: previous?.maxAttempts ?? null,
    retryUntil: previous?.retryUntil ?? null,
    // A fresh page shows a pending reboot notice; one this tab already saw stays dismissed if
    // the user dismissed it, and one that happened while the tab was offline latches now.
    remoteRebooted: previous
      ? previous.remoteRebooted ||
        (summary.statusDetail === 'remote_rebooted' && previous.detail !== 'remote_rebooted')
      : summary.statusDetail === 'remote_rebooted',
    remoteCleanup: summary.state === 'ended' && (previous?.remoteCleanup ?? false),
  };
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * The tab's single WebSocket to session-manager (plan §7): ticket → `hello` → `hello.ok`, the
 * session list and prompts as an observable store, app-level ping, reconnect with backoff and
 * fresh tickets, and channel multiplexing for `TerminalChannel`s (re-attached on reconnect;
 * the server then sends fresh snapshots). The file panel's requests and transfer progress
 * (plan §5.12) ride on it too, through `FileRequests`.
 */
export class TermavoxConnection implements FileApi {
  readonly #store = new Store<ConnectionState>(INITIAL_STATE);
  readonly #channels = new Map<number, TerminalChannel>();
  readonly #urlOverride: string | undefined;
  #url: string | null = null;
  readonly #fetchTicket: TicketFetcher;
  readonly #createWebSocket: WebSocketFactory;
  readonly #pingIntervalMs: number;
  readonly #backoff: BackoffOptions;
  readonly #maxChannels: number;
  readonly #random: () => number;
  readonly #now: () => number;
  #socket: WebSocketLike | null = null;
  #authenticated = false;
  /** Bumped by every attempt and by close(): late results of older attempts are ignored. */
  #attemptToken = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #receivedSincePing = true;
  #nextChannel = 1;
  /** Servers whose `server.remote_sessions` notice the user dismissed in this tab. */
  readonly #dismissedServers = new Set<string>();
  readonly #files: FileRequests;

  constructor(options: TermavoxConnectionOptions = {}) {
    // Resolved on first connect, so constructing during server rendering is harmless.
    this.#urlOverride = options.url;
    this.#fetchTicket = options.fetchTicket ?? fetchWsTicket;
    this.#createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
    this.#pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.#maxChannels = Math.min(options.maxChannels ?? MAX_CHANNELS, MAX_CHANNELS);
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#files = new FileRequests({
      send: (message) => this.#send(message),
      ...(options.fileRequestTimeoutMs !== undefined
        ? { timeoutMs: options.fileRequestTimeoutMs }
        : {}),
    });
  }

  readonly getSnapshot = (): ConnectionState => this.#store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener);

  /** Starts connecting (no-op while connecting or open). Also the "retry" after a fatal error. */
  connect(): void {
    const { status } = this.#store.getSnapshot();
    if (status === 'connecting' || status === 'open') return;
    if (status === 'reconnecting') {
      this.retryNow();
      return;
    }
    this.#store.update({ attempt: 0, error: null });
    void this.#start();
  }

  /** Skips the remaining backoff wait. */
  retryNow(): void {
    if (this.#store.getSnapshot().status !== 'reconnecting') return;
    this.#clearRetryTimer();
    void this.#start();
  }

  /** Closes the socket and stops reconnecting. Channels stay registered for a later connect(). */
  close(): void {
    this.#attemptToken++;
    this.#clearRetryTimer();
    this.#dropSocket(1000, 'client closed');
    this.#store.update({ status: 'closed', retryAt: null, error: null, closeCode: null });
  }

  /** A new pane on this connection. Throws ChannelLimitError beyond 32 open channels. */
  openChannel(options: TerminalChannelOptions): TerminalChannel {
    if (this.#channels.size >= this.#maxChannels) throw new ChannelLimitError(this.#maxChannels);
    let id = this.#nextChannel;
    while (this.#channels.has(id)) id = id >= MAX_CHANNEL_ID ? 1 : id + 1;
    // Never reuse a number soon: frames of a detached channel may still be in flight.
    this.#nextChannel = id >= MAX_CHANNEL_ID ? 1 : id + 1;
    const isReady = (): boolean => this.#isReady();
    const host: ChannelHost = {
      get ready() {
        return isReady();
      },
      send: (message) => this.#send(message),
      sendBinary: (frame) => this.#sendRaw(frame),
      release: (channel) => {
        this.#channels.delete(channel);
      },
    };
    const channel = new TerminalChannel(id, host, options);
    this.#channels.set(id, channel);
    return channel;
  }

  /** Answers a `hostkey.prompt`. Returns false when not connected. */
  hostKeyDecision(sessionId: string, fingerprint: string, accept: boolean): boolean {
    if (!this.#send({ type: 'hostkey.decision', sessionId, fingerprint, accept })) return false;
    const state = this.#store.getSnapshot();
    this.#store.update({ hostKeyPrompts: without(state.hostKeyPrompts, sessionId) });
    return true;
  }

  /** Answers an `auth.prompt` (answers are never logged). Returns false when not connected. */
  authResponse(sessionId: string, promptId: string, answers: string[]): boolean {
    if (!this.#send({ type: 'auth.response', sessionId, promptId, answers })) return false;
    const state = this.#store.getSnapshot();
    if (state.authPrompts[sessionId]?.promptId === promptId) {
      this.#store.update({ authPrompts: without(state.authPrompts, sessionId) });
    }
    return true;
  }

  /**
   * Shows a rename this tab just made (the action's stored label) without waiting for the
   * daemon's `session.upsert`, which carries the same label to every tab. Skipped unless the entry
   * still shows `previous` (its label when the rename started): a newer name that arrived
   * meanwhile, from another browser, stands.
   */
  applyRename(sessionId: string, label: string, previous: string): void {
    this.#patchSession(sessionId, (entry) =>
      entry.label === previous && entry.label !== label ? { ...entry, label } : entry,
    );
  }

  /** Clears the latched "remote host restarted" notice of a session. */
  acknowledgeRemoteReboot(sessionId: string): void {
    this.#patchSession(sessionId, (entry) =>
      entry.remoteRebooted ? { ...entry, remoteRebooted: false } : entry,
    );
  }

  /** Hides a server's remote-sessions notice for the rest of the tab's life. */
  dismissRemoteSessions(serverId: string): void {
    this.#dismissedServers.add(serverId);
    const { remoteSessions } = this.#store.getSnapshot();
    if (remoteSessions.some((n) => n.serverId === serverId)) {
      this.#store.update({ remoteSessions: remoteSessions.filter((n) => n.serverId !== serverId) });
    }
  }

  // ── file panel (plan §5.12) ────────────────────────────────────────────────

  /**
   * One file request on `sessionId`, answered by its `files.result`. Rejects with a
   * FileRequestError: the daemon's code, TIMEOUT after 30 s without an answer (none once a
   * remove reports progress), or CONNECTION_LOST when this tab is not connected or drops.
   */
  fileRequest<R extends FileRequest>(
    sessionId: string,
    request: R,
    options?: FileRequestOptions,
  ): Promise<FileResultOf<R['op']>> {
    return this.#files.fileRequest(sessionId, request, options);
  }

  cancelTransfer(transferId: string): boolean {
    return this.#files.cancelTransfer(transferId);
  }

  /** `transfer.progress` of the uploads and downloads this tab minted, and socket drops. */
  subscribeTransfers(listener: TransferListener): () => void {
    return this.#files.subscribeTransfers(listener);
  }

  // ── connection lifecycle ────────────────────────────────────────────────────

  async #start(): Promise<void> {
    const token = ++this.#attemptToken;
    this.#store.update({ status: 'connecting', retryAt: null });
    let ticket: string;
    try {
      ticket = (await this.#fetchTicket()).ticket;
    } catch (err) {
      if (token !== this.#attemptToken) return;
      if (err instanceof TicketRequestError && (err.status === 401 || err.status === 403)) {
        this.#fail({
          kind: err.status === 401 ? 'unauthenticated' : 'forbidden',
          code: err.status,
        });
      } else {
        this.#scheduleRetry();
      }
      return;
    }
    if (token !== this.#attemptToken) return;
    let socket: WebSocketLike;
    try {
      this.#url ??= resolveWsUrl(this.#urlOverride);
      socket = this.#createWebSocket(this.#url);
      socket.binaryType = 'arraybuffer';
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, ticket }));
    };
    socket.onmessage = (event) => {
      if (this.#socket === socket) this.#onMessage(event.data);
    };
    socket.onclose = (event) => {
      if (this.#socket === socket) this.#onClose(event.code);
    };
    socket.onerror = () => {
      // A close event follows.
    };
  }

  #onClose(code: number): void {
    this.#dropSocket();
    this.#store.update({ closeCode: code });
    const fatal = FATAL_CLOSE.get(code);
    if (fatal) this.#fail({ kind: fatal, code });
    else this.#scheduleRetry(code === CloseCode.RateLimited ? RATE_LIMITED_RETRY_MS : 0);
  }

  /** Backoff (1 s, 2 s, 4 s … 30 s, jittered), never shorter than `minDelayMs`. */
  #scheduleRetry(minDelayMs = 0): void {
    const attempt = this.#store.getSnapshot().attempt + 1;
    const delay = Math.max(minDelayMs, backoffDelay(attempt, this.#backoff, this.#random));
    this.#clearRetryTimer();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#start();
    }, delay);
    this.#store.update({ status: 'reconnecting', attempt, retryAt: this.#now() + delay });
  }

  #fail(error: ConnectionError): void {
    this.#clearRetryTimer();
    this.#dropSocket();
    this.#store.update({ status: 'closed', error, retryAt: null });
  }

  /** Detaches from the current socket (closing it if still open) and tells the channels. */
  #dropSocket(code?: number, reason?: string): void {
    this.#stopPing();
    const socket = this.#socket;
    this.#socket = null;
    const wasAuthenticated = this.#authenticated;
    this.#authenticated = false;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (code !== undefined) {
        try {
          socket.close(code, reason);
        } catch {
          // Already closing.
        }
      }
    }
    if (!wasAuthenticated) return;
    for (const channel of this.#channels.values()) channel.handleDisconnected();
    // Answers of the old socket never arrive: file requests in flight fail now.
    this.#files.disconnected();
  }

  #startPing(): void {
    this.#stopPing();
    this.#receivedSincePing = true;
    this.#pingTimer = setInterval(() => {
      // Nothing (not even the previous pong) arrived for a whole interval: the link is dead.
      if (!this.#receivedSincePing) {
        this.#dropSocket(1000, 'ping timeout');
        this.#scheduleRetry();
        return;
      }
      this.#receivedSincePing = false;
      this.#send({ type: 'ping', t: this.#now() });
    }, this.#pingIntervalMs);
  }

  #stopPing(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #isReady(): boolean {
    return this.#authenticated && this.#socket?.readyState === OPEN;
  }

  #send(message: ClientMessage): boolean {
    return this.#sendRaw(JSON.stringify(message));
  }

  #sendRaw(data: string | Uint8Array<ArrayBuffer>): boolean {
    if (!this.#isReady()) return false;
    this.#socket!.send(data);
    return true;
  }

  // ── incoming ────────────────────────────────────────────────────────────────

  #onMessage(data: unknown): void {
    this.#receivedSincePing = true;
    if (typeof data === 'string') {
      let message: ServerMessage | null;
      try {
        message = parseServerMessage(data);
      } catch {
        return; // malformed known message: ignore
      }
      if (message) this.#onControl(message);
      return;
    }
    const bytes = toBytes(data);
    if (!bytes || !this.#authenticated) return;
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }
    this.#channels.get(frame.channel)?.handleFrame(frame);
  }

  #onControl(message: ServerMessage): void {
    const state = this.#store.getSnapshot();
    switch (message.type) {
      case 'hello.ok':
        this.#authenticated = true;
        this.#store.update({
          status: 'open',
          error: null,
          attempt: 0,
          retryAt: null,
          closeCode: null,
          userId: message.userId,
          shuttingDown: null,
        });
        this.#startPing();
        for (const channel of this.#channels.values()) channel.handleConnected();
        return;
      case 'sessions.list': {
        const previous = new Map(state.sessions.map((s) => [s.id, s]));
        // Prompts still pending are replayed right after the list.
        this.#store.update({
          sessionsLoaded: true,
          sessions: message.sessions.map((s) => toEntry(s, previous.get(s.id))),
          hostKeyPrompts: {},
          authPrompts: {},
        });
        return;
      }
      case 'session.upsert': {
        const { session } = message;
        const index = state.sessions.findIndex((s) => s.id === session.id);
        const sessions = [...state.sessions];
        if (index < 0) sessions.push(toEntry(session));
        else sessions[index] = toEntry(session, state.sessions[index]);
        this.#store.update({ sessions });
        return;
      }
      case 'session.removed':
        this.#store.update({
          sessions: state.sessions.filter((s) => s.id !== message.sessionId),
          hostKeyPrompts: without(state.hostKeyPrompts, message.sessionId),
          authPrompts: without(state.authPrompts, message.sessionId),
        });
        return;
      case 'session.status': {
        const { sessionId, status, detail, retryInMs } = message;
        // A prompt always follows the status that asks for it, so a later status supersedes it.
        // A host-key mismatch prompt belongs to the `failed` state it comes with.
        const keepHostKey = message.state === 'awaiting_host_key' || message.state === 'failed';
        const keepAuth = message.state === 'awaiting_user_input';
        this.#store.update({
          sessions: patchSession(state.sessions, sessionId, (entry) => ({
            ...entry,
            status,
            state: message.state,
            detail: detail ?? null,
            retryInMs: retryInMs ?? null,
            statusAt: this.#now(),
            attempt: message.attempt ?? null,
            maxAttempts: message.maxAttempts ?? null,
            retryUntil: message.retryUntil ?? null,
            remoteRebooted: entry.remoteRebooted || detail === 'remote_rebooted',
            remoteCleanup:
              message.state === 'ended' &&
              (message.remoteCleanup === 'pending' || entry.remoteCleanup),
          })),
          hostKeyPrompts: keepHostKey
            ? state.hostKeyPrompts
            : without(state.hostKeyPrompts, sessionId),
          authPrompts: keepAuth ? state.authPrompts : without(state.authPrompts, sessionId),
        });
        return;
      }
      case 'hostkey.prompt':
        this.#store.update({
          hostKeyPrompts: { ...state.hostKeyPrompts, [message.sessionId]: message },
        });
        return;
      case 'auth.prompt':
        this.#store.update({ authPrompts: { ...state.authPrompts, [message.sessionId]: message } });
        return;
      case 'server.remote_sessions': {
        const { serverId, serverName, count } = message;
        if (this.#dismissedServers.has(serverId)) return;
        const notice = { serverId, serverName, count };
        const index = state.remoteSessions.findIndex((n) => n.serverId === serverId);
        const remoteSessions = [...state.remoteSessions];
        if (index < 0) remoteSessions.push(notice);
        else remoteSessions[index] = notice;
        this.#store.update({ remoteSessions });
        return;
      }
      case 'server.shutting_down':
        this.#store.update({
          shuttingDown: { expectedBackInMs: message.expectedBackInMs ?? null },
        });
        return;
      case 'error':
        if (message.channel !== undefined)
          this.#channels.get(message.channel)?.handleMessage(message);
        else this.#store.update({ lastError: message });
        return;
      case 'session.attached':
      case 'terminal.resized':
      case 'terminal.title':
      case 'terminal.bell':
      case 'terminal.hint':
        this.#channels.get(message.channel)?.handleMessage(message);
        return;
      case 'files.result':
      case 'files.progress':
      case 'transfer.progress':
        this.#files.handle(message);
        return;
      case 'pong':
        return;
    }
  }

  #patchSession(sessionId: string, patch: (entry: SessionEntry) => SessionEntry): void {
    const { sessions } = this.#store.getSnapshot();
    const updated = patchSession(sessions, sessionId, patch);
    if (updated !== sessions) this.#store.update({ sessions: updated });
  }
}

/** Returns `sessions` itself when the session is unknown or the patch changes nothing. */
function patchSession(
  sessions: readonly SessionEntry[],
  sessionId: string,
  patch: (entry: SessionEntry) => SessionEntry,
): readonly SessionEntry[] {
  const index = sessions.findIndex((s) => s.id === sessionId);
  if (index < 0) return sessions;
  const next = patch(sessions[index]!);
  if (next === sessions[index]) return sessions;
  const updated = [...sessions];
  updated[index] = next;
  return updated;
}
