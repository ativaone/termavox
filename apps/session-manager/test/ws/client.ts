/**
 * Test clients that behave like the browser (plan §5.4 step 6): a client-side HeadlessEmulator
 * per channel restored from SNAPSHOT frames (reset → resize → write; HeadlessEmulator aligns
 * UTF-8 with its own Utf8Aligner), OUTPUT frames applied in seq order, and `terminal.resized`
 * applied at its position in the stream.
 */
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import {
  type ClientMessage,
  decodeFrame,
  encodeFrame,
  FrameType,
  type ServerMessage,
} from '@termdock/protocol';
import { DEFAULT_SCROLLBACK } from '@termdock/terminal-config';
import { WebSocket } from 'ws';
import type { BoundFrame } from '../../src/attachments/wire.ts';
import { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';

const gunzipAsync = promisify(gunzip);

/** One channel's terminal on the client side. */
export class ClientTerminal {
  emulator: HeadlessEmulator | null = null;
  scrollback = DEFAULT_SCROLLBACK;
  snapshotSeq = -1;
  lastSeq = -1;
  readonly snapshots: Array<{ seq: number; cols: number; rows: number }> = [];
  readonly outputSeqs: number[] = [];
  readonly resizes: Array<{ cols: number; rows: number; seq: number; active: boolean }> = [];
  readonly messages: ServerMessage[] = [];
  /** Ordering violations (must stay empty). */
  readonly violations: string[] = [];
  #queue: Promise<void> = Promise.resolve();

  push(frame: BoundFrame): void {
    this.#queue = this.#queue.then(() => this.#apply(frame));
  }

  /** Waits until every received frame is applied and parsed. */
  async settle(): Promise<HeadlessEmulator> {
    await this.#queue;
    if (!this.emulator) throw new Error('no snapshot received');
    await this.emulator.flush();
    return this.emulator;
  }

  async #apply(frame: BoundFrame): Promise<void> {
    if (!frame.binary) {
      const message = JSON.parse(frame.data) as ServerMessage;
      this.messages.push(message);
      if (message.type === 'session.attached') this.scrollback = message.scrollbackLines;
      if (message.type === 'terminal.resized') {
        if (message.seq !== this.lastSeq) {
          this.violations.push(`resized at seq ${message.seq} after OUTPUT ${this.lastSeq}`);
        }
        this.resizes.push({ ...message, active: message.activeAttachment });
        this.emulator?.resize({ cols: message.cols, rows: message.rows });
      }
      return;
    }
    const decoded = decodeFrame(frame.data);
    const seq = Number(decoded.seq);
    if (decoded.type === FrameType.Snapshot) {
      const payload = await gunzipAsync(decoded.payload);
      const size = decoded.size!;
      this.emulator?.dispose();
      this.emulator = new HeadlessEmulator({
        cols: 80,
        rows: 24,
        scrollback: this.scrollback,
        answerQueries: false,
      });
      this.emulator.resize(size);
      this.emulator.write(payload);
      this.snapshots.push({ seq, ...size });
      this.snapshotSeq = seq;
      this.lastSeq = seq;
      return;
    }
    if (decoded.type !== FrameType.Output) return;
    if (!this.emulator) {
      this.violations.push(`OUTPUT ${seq} before any SNAPSHOT`);
      return;
    }
    if (seq <= this.lastSeq) {
      this.violations.push(`OUTPUT ${seq} not after ${this.lastSeq}`);
      return;
    }
    this.outputSeqs.push(seq);
    this.lastSeq = seq;
    this.emulator.write(decoded.payload);
  }
}

const CHANNEL_SCOPED = new Set([
  'session.attached',
  'terminal.resized',
  'terminal.title',
  'terminal.bell',
]);

/** A WebSocket client speaking protocol v1. */
export class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  readonly terminals = new Map<number, ClientTerminal>();
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #waiters = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
        this.#notify();
      });
    });
    ws.on('message', (data, isBinary) => {
      const buf = data as Buffer;
      if (isBinary) {
        const channel = decodeFrame(buf).channel;
        this.terminal(channel).push({ binary: true, data: new Uint8Array(buf) });
      } else {
        const text = buf.toString('utf8');
        const message = JSON.parse(text) as ServerMessage;
        this.messages.push(message);
        if (CHANNEL_SCOPED.has(message.type) && 'channel' in message) {
          this.terminal(message.channel as number).push({ binary: false, data: text });
        }
      }
      this.#notify();
    });
  }

  static open(url: string, origin: string): Promise<TestClient> {
    const ws = new WebSocket(url, { origin });
    const client = new TestClient(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  /** Opens, says hello and waits for `hello.ok`. */
  static async connect(url: string, origin: string, ticket: string): Promise<TestClient> {
    const client = await TestClient.open(url, origin);
    client.send({ type: 'hello', protocol: 1, ticket });
    await client.next((m) => m.type === 'hello.ok');
    return client;
  }

  terminal(channel: number): ClientTerminal {
    let terminal = this.terminals.get(channel);
    if (!terminal) {
      terminal = new ClientTerminal();
      this.terminals.set(channel, terminal);
    }
    return terminal;
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  input(channel: number, text: string): void {
    const payload = new TextEncoder().encode(text);
    this.ws.send(encodeFrame({ type: FrameType.Input, flags: 0, channel, seq: 0n, payload }));
  }

  /** The first message (already received or future) matching `predicate`. */
  next<T extends ServerMessage>(
    predicate: (m: ServerMessage) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
  next(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  next(predicate: (m: ServerMessage) => boolean, timeoutMs = 10_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const found = this.messages.find(predicate);
        if (!found) return false;
        cleanup();
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for a message; got ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
      };
      const waiter = (): void => {
        check();
      };
      if (!check()) this.#waiters.add(waiter);
    });
  }

  close(): Promise<{ code: number; reason: string }> {
    this.ws.close();
    return this.closed;
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}
