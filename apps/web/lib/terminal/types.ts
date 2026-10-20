import type { ParserHost } from '@termavox/terminal-config';

export interface Dimensions {
  cols: number;
  rows: number;
}

export interface Disposable {
  dispose(): void;
}

/**
 * The part of the xterm `Terminal` API the client needs. `@xterm/xterm` (browser) and
 * `@xterm/headless` (tests) both satisfy it, so tests can inject a headless terminal.
 * `parser` is used to install the query silencer (plan §5.3).
 */
export interface TerminalLike extends ParserHost {
  readonly cols: number;
  readonly rows: number;
  options: { scrollback?: number };
  write(data: string | Uint8Array, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): Disposable;
  /** Raw bytes as a latin1 string (legacy X10 mouse reports). */
  onBinary(listener: (data: string) => void): Disposable;
  /** `sendFocusMode`: the program asked for focus reports (DECSET 1004). */
  readonly modes: { readonly sendFocusMode: boolean };
  /** The browser terminal's input element (absent in headless terminals): real focus changes. */
  readonly textarea?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | undefined;
}

// Method-shorthand types are bivariant, so the DOM WebSocket and the `ws` package (whose event
// types differ) both satisfy WebSocketLike without casts.
type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

/** The standard WebSocket API surface the connection uses (browser WebSocket or `ws`). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
}

/** Opens a socket. Tests pass e.g. `(url) => new WebSocket(url, { origin })` from `ws`. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** Response of `POST /api/ws/ticket` (plan §7.1). Never log it. */
export interface WsTicket {
  ticket: string;
  expiresAt: number;
}

export type TicketFetcher = () => Promise<WsTicket>;
