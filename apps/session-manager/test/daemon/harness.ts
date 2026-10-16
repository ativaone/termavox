/**
 * T1 harness for the real daemon wiring (SQLite stores, vault, internal API, WS) booted
 * in-process: one data directory per fixture, so restarts reuse the same DB.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerMessage, signTicket } from '@termdock/protocol';
import type { DaemonConfig } from '../../src/config/config.ts';
import type { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';
import { type Daemon, startDaemon } from '../../src/main.ts';
import { TestClient } from '../ws/client.ts';

export const ORIGIN = 'http://localhost:3000';
export const VIEWPORT = { cols: 100, rows: 30 } as const;

export class DaemonFixture {
  readonly dir: string;
  readonly config: DaemonConfig;
  readonly daemons: Daemon[] = [];
  readonly clients: TestClient[] = [];
  readonly #token = randomBytes(32).toString('base64url');
  readonly #wsSecret = randomBytes(32).toString('base64url');

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'termdock-daemon-'));
    const secret = (name: string, value: string): string => {
      const path = join(this.dir, name);
      writeFileSync(path, `${value}\n`, { mode: 0o600 });
      return path;
    };
    this.config = {
      publicUrl: ORIGIN,
      publicOrigin: ORIGIN,
      wsHost: '127.0.0.1',
      wsPort: 0,
      wsSecretFile: secret('ws_secret', this.#wsSecret),
      logLevel: 'silent',
      dataDir: this.dir,
      trustedProxies: [],
      masterKeyFile: secret('master_key', randomBytes(32).toString('base64')),
      internalTokenFile: secret('internal_token', this.#token),
      internalHost: '127.0.0.1',
      internalPort: 0,
      enableLocalShell: false,
      dbFile: join(this.dir, 'app.db'),
    };
  }

  async boot(): Promise<Daemon> {
    const daemon = await startDaemon(this.config);
    this.daemons.push(daemon);
    return daemon;
  }

  /** Internal API call with the bearer token. */
  async api(
    daemon: Daemon,
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const res = await fetch(`http://127.0.0.1:${daemon.internalAddress.port}/internal/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
  }

  /** A WebSocket client authenticated with a fresh ticket. */
  async connect(daemon: Daemon, userId: string, asid: string): Promise<TestClient> {
    const ticket = signTicket(new TextEncoder().encode(this.#wsSecret), { uid: userId, asid });
    const client = await TestClient.connect(
      `ws://127.0.0.1:${daemon.wsAddress.port}/ws`,
      ORIGIN,
      ticket,
    );
    this.clients.push(client);
    return client;
  }

  /** Connects and attaches `sessionId` on channel 1. */
  async attach(daemon: Daemon, userId: string, asid: string, sessionId: string) {
    const client = await this.connect(daemon, userId, asid);
    client.send({ type: 'session.attach', channel: 1, sessionId, viewport: VIEWPORT });
    await client.next((m) => m.type === 'session.attached');
    return client;
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})));
    for (const daemon of this.daemons) await daemon.shutdown().catch(() => {});
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Every line of the active buffer (scrollback + screen). */
export function bufferText(emulator: HeadlessEmulator): string {
  const buffer = emulator.terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)!.translateToString(true));
  return lines.join('\n');
}

/** The visible rows only (an array: comparisons then show which rows differ). */
export function screenRows(emulator: HeadlessEmulator): string[] {
  const buffer = emulator.terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < emulator.rows; y++) {
    lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
  }
  return lines;
}

/** Waits until the client's terminal (channel 1) shows `pattern` anywhere in its buffer. */
export async function shows(
  client: TestClient,
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<string> {
  const terminal = client.terminal(1);
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (terminal.emulator) {
      text = bufferText(await terminal.settle());
      if (pattern.test(text)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`terminal never showed ${pattern}; buffer:\n${text.slice(-3000)}`);
}

/** Resolves once channel 1 received no frame for `quietMs`, with every frame applied. */
export async function settled(client: TestClient, quietMs = 400): Promise<HeadlessEmulator> {
  const terminal = client.terminal(1);
  let last = -2;
  let since = Date.now();
  for (;;) {
    const mark = terminal.lastSeq + terminal.snapshots.length;
    if (mark !== last) {
      last = mark;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return terminal.settle();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The first `session.status` of `sessionId` received at or after `from` matching `status`. */
export function statusAfter(
  client: TestClient,
  from: number,
  sessionId: string,
  status: string,
  timeoutMs = 30_000,
): Promise<ServerMessage> {
  return client.next(
    (m) =>
      m.type === 'session.status' &&
      m.sessionId === sessionId &&
      m.status === status &&
      client.messages.indexOf(m) >= from,
    timeoutMs,
  );
}
