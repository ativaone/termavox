/**
 * Test helpers for the browser terminal client.
 *
 * `@xterm/headless`, `@xterm/addon-serialize` and `ws` are dependencies of session-manager only
 * and are not resolvable from apps/web, so they are loaded from session-manager's node_modules
 * (test code only). Their typings come in through the HeadlessEmulator import graph.
 */
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import {
  type ClientMessage,
  decodeFrame,
  encodeFrame,
  FrameFlag,
  FrameType,
  type ServerMessage,
  type SessionSummary,
} from '@termavox/protocol';
import {
  installQuerySilencer,
  sharedTerminalOptions,
  UNICODE_VERSION,
} from '@termavox/terminal-config';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Terminal } from '@xterm/headless';
import { HeadlessEmulator } from '../../../session-manager/src/emulator/headless-emulator.ts';
import type { WebSocketLike } from '../../lib/terminal/types.ts';

const requireFromSessionManager = createRequire(
  new URL('../../../session-manager/package.json', import.meta.url),
);
const headless = requireFromSessionManager('@xterm/headless') as typeof import('@xterm/headless');
// The addon's typings are a module augmentation of @xterm/xterm, so declare what is used here.
const serialize = requireFromSessionManager('@xterm/addon-serialize') as {
  SerializeAddon: new () => { serialize(): string; dispose(): void };
};

export type HeadlessTerminal = Terminal;

/** A client terminal configured like the browser's (shared options, Unicode 11, silencer last). */
export function createClientTerminal(): Terminal {
  const term = new headless.Terminal({ ...sharedTerminalOptions, cols: 80, rows: 24 });
  term.loadAddon(new Unicode11Addon() as unknown as Parameters<Terminal['loadAddon']>[0]);
  term.unicode.activeVersion = UNICODE_VERSION;
  installQuerySilencer(term);
  return term;
}

/** Everything that must match between two terminals: serialized buffers, cursor, modes. */
export function fingerprint(term: Terminal): Record<string, unknown> {
  const serializer = new serialize.SerializeAddon();
  term.loadAddon(serializer as unknown as Parameters<Terminal['loadAddon']>[0]);
  const serialized = serializer.serialize();
  serializer.dispose();
  const buffer = term.buffer.active;
  return {
    size: `${term.cols}x${term.rows}`,
    buffer: buffer.type,
    cursor: `${buffer.cursorX},${buffer.cursorY}`,
    baseY: buffer.baseY,
    length: buffer.length,
    normalLength: term.buffer.normal.length,
    scrollback: term.options.scrollback,
    cursorStyle: term.options.cursorStyle,
    cursorBlink: term.options.cursorBlink,
    modes: { ...term.modes },
    serialized,
  };
}

/** Every line of the active buffer. */
export function bufferText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)!.translateToString(true));
  return lines.join('\n');
}

export async function until(
  predicate: () => boolean,
  timeoutMs = 3_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what} not met in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const encoder = new TextEncoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);

/**
 * The server side of one session: an authoritative HeadlessEmulator plus the seq counter, which
 * produces the frames session-manager would send (plan §5.4/§5.5).
 */
export class ScriptedSession {
  readonly emulator: HeadlessEmulator;
  readonly scrollbackLines: number;
  seq = 0;

  constructor(opts: { cols?: number; rows?: number; scrollbackLines?: number; seq?: number } = {}) {
    this.scrollbackLines = opts.scrollbackLines ?? 5_000;
    this.seq = opts.seq ?? 0;
    this.emulator = new HeadlessEmulator({
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      scrollback: this.scrollbackLines,
      answerQueries: false,
    });
  }

  /** Feeds one chunk to the emulator and returns its OUTPUT frame. */
  output(channel: number, chunk: Uint8Array | string): Uint8Array {
    const payload = typeof chunk === 'string' ? utf8(chunk) : chunk;
    this.seq++;
    this.emulator.write(payload);
    return encodeFrame({
      type: FrameType.Output,
      flags: 0,
      channel,
      seq: BigInt(this.seq),
      payload,
    });
  }

  /** A sequenced resize: the emulator resizes through its write queue, then the message. */
  resize(channel: number, cols: number, rows: number, activeAttachment = true): string {
    this.emulator.resize({ cols, rows });
    return this.resized(channel, activeAttachment);
  }

  /** `terminal.resized` at the current size (e.g. an activeAttachment flip). */
  resized(channel: number, activeAttachment: boolean): string {
    return JSON.stringify({
      type: 'terminal.resized',
      channel,
      cols: this.emulator.cols,
      rows: this.emulator.rows,
      seq: this.seq,
      activeAttachment,
    } satisfies ServerMessage);
  }

  attached(channel: number, sessionId: string): string {
    return JSON.stringify({
      type: 'session.attached',
      channel,
      sessionId,
      cols: this.emulator.cols,
      rows: this.emulator.rows,
      scrollbackLines: this.scrollbackLines,
    } satisfies ServerMessage);
  }

  /** Snapshot barrier now (seq and size recorded synchronously); resolves to the frame. */
  snapshot(channel: number, gzip = true): Promise<Uint8Array> {
    const seq = this.seq;
    const { cols, rows } = this.emulator;
    return this.emulator.snapshot().then((raw) =>
      encodeFrame({
        type: FrameType.Snapshot,
        flags: gzip ? FrameFlag.Gzip : 0,
        channel,
        seq: BigInt(seq),
        size: { cols, rows },
        payload: gzip ? gzipSync(raw) : raw,
      }),
    );
  }

  get terminal(): Terminal {
    return this.emulator.terminal;
  }

  dispose(): void {
    this.emulator.dispose();
  }
}

export function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    label: `session ${id}`,
    serverId: null,
    serverName: 'host',
    kind: 'ssh',
    hostname: 'host.test',
    port: 22,
    username: 'tv',
    state: 'ready',
    status: 'connected',
    protection: 'none',
    createdAt: 0,
    lastReadyAt: 0,
    endedAt: null,
    endReason: null,
    statusDetail: null,
    ...extra,
  };
}

type Handler<E> = ((event: E) => void) | null;

/** In-process stand-in for a WebSocket: the test plays the server. */
export class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: Handler<unknown> = null;
  onmessage: Handler<{ data: unknown }> = null;
  onclose: Handler<{ code: number; reason: string }> = null;
  onerror: Handler<unknown> = null;
  readonly control: ClientMessage[] = [];
  readonly binary: ReturnType<typeof decodeFrame>[] = [];
  closedByClient: { code?: number; reason?: string } | null = null;
  readonly #server: FakeServer;
  readonly url: string;

  constructor(url: string, server: FakeServer) {
    this.url = url;
    this.#server = server;
  }

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      const message = JSON.parse(data) as ClientMessage;
      this.control.push(message);
      this.#server.handle(this, message);
    } else {
      this.binary.push(decodeFrame(new Uint8Array(data)));
    }
  }

  close(code?: number, reason?: string): void {
    this.closedByClient = {
      ...(code !== undefined ? { code } : {}),
      ...(reason ? { reason } : {}),
    };
    this.readyState = 3;
  }

  // ── server side ──

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(data: string | Uint8Array): void {
    if (typeof data === 'string') this.onmessage?.({ data });
    else this.onmessage?.({ data: new Uint8Array(data).buffer });
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** Accepts hellos, sends the session list and pending prompts, and delegates attaches. */
export class FakeServer {
  readonly sockets: FakeSocket[] = [];
  readonly tickets: string[] = [];
  sessions: SessionSummary[] = [];
  pendingPrompts: ServerMessage[] = [];
  /** Replace to script attach handling. */
  onAttach: (
    socket: FakeSocket,
    message: Extract<ClientMessage, { type: 'session.attach' }>,
  ) => void = () => {};

  readonly createWebSocket = (url: string): FakeSocket => {
    const socket = new FakeSocket(url, this);
    this.sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('no socket');
    return socket;
  }

  handle(socket: FakeSocket, message: ClientMessage): void {
    switch (message.type) {
      case 'hello':
        this.tickets.push(message.ticket);
        socket.deliver(
          JSON.stringify({ type: 'hello.ok', protocol: 1, userId: 'u1', serverTime: 0 }),
        );
        socket.deliver(JSON.stringify({ type: 'sessions.list', sessions: this.sessions }));
        for (const prompt of this.pendingPrompts) socket.deliver(JSON.stringify(prompt));
        return;
      case 'session.attach':
        this.onAttach(socket, message);
        return;
      default:
        return;
    }
  }
}
