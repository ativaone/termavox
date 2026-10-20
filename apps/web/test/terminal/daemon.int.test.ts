// T1: the browser terminal client (TermavoxConnection + TerminalChannel over `ws`, a headless
// terminal configured like the browser's) against the real daemon booted in-process and the
// no-tmux sshd. Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { signTicket, TICKET_TTL_MS } from '@termavox/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HeadlessEmulator } from '../../../session-manager/src/emulator/headless-emulator.ts';
import { TermavoxConnection, type TerminalChannel } from '../../lib/terminal/index.ts';
import type { Dimensions, WebSocketLike } from '../../lib/terminal/types.ts';
import {
  bufferText,
  createClientTerminal,
  fingerprint,
  type HeadlessTerminal,
  sleep,
  until,
} from './helpers.ts';

/**
 * session-manager modules are loaded through computed specifiers: a static (even type-only)
 * import would pull the daemon's source graph into apps/web's tsc program, where Next.js's
 * NodeJS.ProcessEnv augmentation breaks ssh-transport.ts. `ws` is a session-manager dependency.
 */
const load = <T>(path: string): Promise<T> =>
  import(/* @vite-ignore */ new URL(`../../../session-manager/${path}`, import.meta.url).href);

interface Runtime {
  readonly state: string;
  readonly seq: number;
  readonly emulator: HeadlessEmulator;
}
interface Daemon {
  readonly db: unknown;
  readonly wsAddress: { port: number };
  readonly credentials: {
    create(input: Record<string, unknown>): Promise<{ credentialId: string }>;
  };
  readonly plane: { registry: { host(sessionId: string): Runtime | undefined } };
}
interface TestClient {
  send(message: Record<string, unknown>): void;
  input(channel: number, text: string): void;
  next(predicate: (m: { type: string }) => boolean, timeoutMs?: number): Promise<unknown>;
}
interface Fixture {
  readonly config: { wsSecretFile: string };
  boot(): Promise<Daemon>;
  api(
    daemon: Daemon,
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> | null }>;
  connect(daemon: Daemon, userId: string, asid: string): Promise<TestClient>;
  cleanup(): Promise<void>;
}

const VIEWPORT: Dimensions = { cols: 100, rows: 30 };
const PROMPT = /\$ ?$/m;

let fixture: Fixture;
let daemon: Daemon;
let sessionId: string;
let connection: TermavoxConnection;
let channel: TerminalChannel;
let term: HeadlessTerminal;
let second: TestClient;
let userId: string;
let asid: string;

const runtime = (): Runtime => daemon.plane.registry.host(sessionId)!;

async function shows(pattern: RegExp, timeoutMs = 15_000): Promise<void> {
  await until(() => pattern.test(bufferText(term)), timeoutMs, `terminal showing ${pattern}`);
}

/** Once the session is quiet, the client terminal equals the server emulator byte for byte. */
async function expectMirrored(quietMs = 300): Promise<void> {
  let seq = runtime().seq;
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    await sleep(25);
    if (runtime().seq !== seq) {
      seq = runtime().seq;
      since = Date.now();
    }
  }
  await channel.settled();
  await runtime().emulator.flush();
  expect(fingerprint(term)).toEqual(fingerprint(runtime().emulator.terminal));
}

beforeAll(async () => {
  const sshd = await load<{
    SSHD_PORTS: Record<'no-tmux', number>;
    HOST_KEY: { type: string; fingerprint: string };
    USER_KEY: string;
    TEST_USER: string;
    requireSshd(images: string[]): Promise<void>;
  }>('test/ssh/sshd.ts');
  await sshd.requireSshd(['no-tmux']);
  const { DaemonFixture, ORIGIN } = await load<{
    DaemonFixture: new () => Fixture;
    ORIGIN: string;
  }>('test/daemon/harness.ts');
  const store = await load<{
    insertUser(db: unknown): string;
    insertServer(
      db: unknown,
      userId: string,
      opts: { name: string; port: number; username: string; credentialId: string },
    ): string;
    insertAuthSession(db: unknown, userId: string, expiresAt: number): string;
  }>('test/store/fixture.ts');
  const { readSecretFile } = await load<{ readSecretFile(path: string): Promise<Uint8Array> }>(
    'src/config/config.ts',
  );
  const { WebSocket } = await load<{
    WebSocket: new (url: string, options: { origin: string }) => WebSocketLike;
  }>('node_modules/ws/wrapper.mjs');

  fixture = new DaemonFixture();
  daemon = await fixture.boot();
  const { db } = daemon;
  userId = store.insertUser(db);
  // The server points at its credential (a foreign key), so the credential comes first.
  const { credentialId } = await daemon.credentials.create({
    actingUserId: userId,
    kind: 'private_key',
    name: 'test key',
    privateKey: sshd.USER_KEY,
  });
  const serverId = store.insertServer(db, userId, {
    name: 'no-tmux',
    port: sshd.SSHD_PORTS['no-tmux'],
    username: sshd.TEST_USER,
    credentialId,
  });
  const trusted = await fixture.api(daemon, 'POST', `/servers/${serverId}/trust-key`, {
    actingUserId: userId,
    keyType: sshd.HOST_KEY.type,
    fingerprint: sshd.HOST_KEY.fingerprint.slice('SHA256:'.length),
  });
  expect(trusted.status).toBe(204);
  asid = store.insertAuthSession(db, userId, Date.now() + 3_600_000);
  const created = await fixture.api(daemon, 'POST', '/sessions', {
    actingUserId: userId,
    serverId,
    viewport: VIEWPORT,
  });
  expect(created.status).toBe(201);
  sessionId = created.json?.sessionId as string;
  await until(() => daemon.plane.registry.host(sessionId)?.state === 'ready', 15_000, 'ready');

  const secret = await readSecretFile(fixture.config.wsSecretFile);
  connection = new TermavoxConnection({
    url: `ws://127.0.0.1:${daemon.wsAddress.port}/ws`,
    fetchTicket: async () => ({
      ticket: signTicket(secret, { uid: userId, asid }),
      expiresAt: Date.now() + TICKET_TTL_MS,
    }),
    createWebSocket: (url) => new WebSocket(url, { origin: ORIGIN }),
  });
  term = createClientTerminal();
  channel = connection.openChannel({ terminal: term });
});

afterAll(async () => {
  connection?.close();
  term?.dispose();
  await fixture?.cleanup();
});

describe('browser terminal client against the real daemon (no-tmux)', () => {
  it('connects with a ticket, attaches, and mirrors typed output byte for byte', async () => {
    connection.connect();
    await until(() => connection.getSnapshot().status === 'open', 5_000, 'open');
    expect(connection.getSnapshot().sessions.map((s) => s.id)).toContain(sessionId);
    channel.attach(sessionId, VIEWPORT);
    await until(() => channel.getSnapshot().phase === 'live', 5_000, 'live');
    await shows(PROMPT);
    channel.input('echo web-$((6*7))\r');
    await shows(/^web-42$/m);
    await expectMirrored();
    expect(channel.getSnapshot()).toMatchObject({ size: VIEWPORT, active: true });
  });

  it('detach and reattach: a fresh snapshot replaces the state (now passive)', async () => {
    second = await fixture.connect(daemon, userId, asid);
    second.send({
      type: 'session.attach',
      channel: 1,
      sessionId,
      viewport: { cols: 80, rows: 24 },
    });
    await second.next((m) => m.type === 'session.attached');
    channel.detach();
    expect(channel.getSnapshot().phase).toBe('idle');
    // The other client types: it becomes active and the session takes its viewport.
    second.input(1, 'echo detached-$((1+1))\r');
    await until(() => runtime().emulator.cols === 80, 5_000, 'session at 80 cols');

    channel.attach(sessionId, VIEWPORT);
    await until(() => channel.getSnapshot().phase === 'live', 5_000, 'live again');
    await shows(/^detached-2$/m);
    await expectMirrored();
    expect(channel.getSnapshot()).toMatchObject({ size: { cols: 80, rows: 24 }, active: false });
  });

  it('a resize from the other client lands at its seq position; activate takes the size back', async () => {
    second.send({ type: 'terminal.viewport', channel: 1, cols: 90, rows: 26 });
    await until(() => channel.getSnapshot().size?.cols === 90, 5_000, 'resized to 90x26');
    second.input(1, 'seq 1 40\r');
    await shows(/^40$/m);
    await expectMirrored();
    expect(channel.getSnapshot()).toMatchObject({ size: { cols: 90, rows: 26 }, active: false });

    channel.activate();
    await until(() => channel.getSnapshot().active, 5_000, 'active');
    await until(() => channel.getSnapshot().size?.cols === VIEWPORT.cols, 5_000, 'own size');
    channel.input('echo mine\r');
    await shows(/^mine$/m);
    await expectMirrored();
    expect(channel.getSnapshot().size).toEqual(VIEWPORT);
  });

  it('a rename reaches the client store and the other connection live (D-28)', async () => {
    const renamed = await fixture.api(daemon, 'PATCH', `/sessions/${sessionId}`, {
      actingUserId: userId,
      label: ' web\u202E box\u200B ',
    });
    expect(renamed).toEqual({ status: 200, json: { sessionId, label: 'web box' } });
    const label = () => connection.getSnapshot().sessions.find((s) => s.id === sessionId)?.label;
    await until(() => label() === 'web box', 5_000, 'renamed in the client store');
    await second.next(
      (m) =>
        m.type === 'session.upsert' &&
        (m as { session?: { id: string; label: string } }).session?.label === 'web box',
    );
    // Same socket, still attached and live: a rename touches nothing but the name.
    expect(connection.getSnapshot().status).toBe('open');
    expect(channel.getSnapshot().phase).toBe('live');
  });
});
