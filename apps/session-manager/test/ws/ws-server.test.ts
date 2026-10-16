import { CloseCode, type ServerMessage, signTicket } from '@termdock/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeChannelMessage } from '../../src/attachments/wire.ts';
import type {
  AttachmentClient,
  AttachmentHandle,
  Dimensions,
  SessionHost,
} from '../../src/core/types.ts';
import {
  MAX_ATTACHMENTS_PER_USER,
  MAX_CHANNELS,
  MAX_CONNECTIONS_PER_USER,
  MAX_IN_FLIGHT,
  WsServer,
} from '../../src/ws/server.ts';
import type { SessionGateway } from '../../src/ws/types.ts';
import { until } from '../runtime/fakes.ts';
import { TestClient } from './client.ts';

const ORIGIN = 'https://termdock.test';
const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret!');

class FakeHost implements SessionHost {
  readonly sessionId: string;
  readonly attached: Array<{
    handle: AttachmentHandle;
    viewport: Dimensions;
    client: AttachmentClient | undefined;
  }> = [];
  readonly inputs: string[] = [];
  readonly detached: string[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async start(): Promise<void> {}
  attach(handle: AttachmentHandle, viewport: Dimensions, client?: AttachmentClient): void {
    this.attached.push({ handle, viewport, client });
    handle.send(
      encodeChannelMessage({
        type: 'session.attached',
        sessionId: this.sessionId,
        ...viewport,
        scrollbackLines: 1000,
      }),
    );
  }
  detach(attachmentId: string): void {
    this.detached.push(attachmentId);
  }
  input(_attachmentId: string, data: Uint8Array): void {
    this.inputs.push(Buffer.from(data).toString());
  }
  activate(): void {}
  viewport(): void {}
  resync(): void {}
  async retry(): Promise<void> {}
  async terminate(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

const hosts = new Map([
  ['s-alice', new FakeHost('s-alice')],
  ['s-bob', new FakeHost('s-bob')],
  ['s-dave', new FakeHost('s-dave')],
]);
const owners = new Map([
  ['s-alice', 'alice'],
  ['s-bob', 'bob'],
  ['s-slow', 'alice'],
  ['s-evicted', 'alice'],
  ['s-dave', 'dave'],
]);
/** An attach to s-slow waits for this, holding its connection's message queue. */
let slowAttach: Promise<void> = Promise.resolve();
/** s-evicted: the first load returns a runtime that the registry replaced right after. */
const evicted = { stale: new FakeHost('s-evicted'), fresh: new FakeHost('s-evicted'), loads: 0 };
const invalidAuthSessions = new Set<string>(['asid-revoked']);
/** Keyboard-interactive prompts waiting per user, and the answers routed to the gateway. */
const waiting = new Map<string, ServerMessage[]>();
const authResponses: Array<[string, string, string[], string]> = [];

const gateway: SessionGateway = {
  host: (id) => (id === 's-evicted' ? evicted.fresh : hosts.get(id)),
  attachable: async (id) => {
    if (id === 's-slow') {
      await slowAttach;
      return hosts.get('s-alice') ?? null;
    }
    if (id === 's-evicted') return evicted.loads++ === 0 ? evicted.stale : evicted.fresh;
    return hosts.get(id) ?? null;
  },
  listForUser: async () => [],
  pendingPrompts: (userId) => waiting.get(userId) ?? [],
  hostKeyDecision: async () => false,
  authResponse: (sessionId, promptId, answers, userId) => {
    authResponses.push([sessionId, promptId, answers, userId]);
    return true;
  },
};

let server: WsServer;
let url: string;

const ticket = (uid = 'alice', asid = `asid-${uid}`, now = Date.now()): string =>
  signTicket(SECRET, { uid, asid }, now);
const connect = (uid = 'alice'): Promise<TestClient> =>
  TestClient.connect(url, ORIGIN, ticket(uid));

beforeAll(async () => {
  server = new WsServer({
    host: '127.0.0.1',
    port: 0,
    publicOrigin: ORIGIN,
    secret: SECRET,
    authSessions: { isValid: (asid) => !invalidAuthSessions.has(asid) },
    ownership: { sessionOwner: async (id) => owners.get(id) ?? null },
    sessions: gateway,
  });
  const address = await server.listen();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(async () => {
  await server.close();
});

describe('WebSocket server', () => {
  it('closes a foreign Origin with 4403 before any hello', async () => {
    const client = await TestClient.open(url, 'https://evil.test');
    expect((await client.closed).code).toBe(CloseCode.Forbidden);
  });

  it('rejects expired, replayed and revoked tickets with 4401, a wrong protocol with 4409', async () => {
    const hello = async (t: string, protocol = 1): Promise<number> => {
      const client = await TestClient.open(url, ORIGIN);
      client.send({ type: 'hello', protocol, ticket: t });
      return (await client.closed).code;
    };
    expect(await hello(ticket('alice', 'asid-alice', Date.now() - 60_000))).toBe(
      CloseCode.Unauthenticated,
    );
    expect(await hello(ticket('alice', 'asid-revoked'))).toBe(CloseCode.Unauthenticated);
    expect(await hello(ticket(), 2)).toBe(CloseCode.ProtocolUnsupported);

    const once = ticket();
    const first = await TestClient.connect(url, ORIGIN, once);
    expect(await hello(once)).toBe(CloseCode.Unauthenticated); // single use
    await first.close();
  });

  it('sends sessions.list after hello.ok, ignores unknown types and rejects malformed known ones', async () => {
    const client = await connect();
    expect(client.messages.map((m) => m.type)).toEqual(['hello.ok', 'sessions.list']);
    client.send({ type: 'future.feature', anything: true });
    client.send({ type: 'terminal.viewport', channel: -1, cols: 0, rows: 0 });
    client.send({ type: 'ping', t: 42 });
    await client.next((m) => m.type === 'pong');
    const types = client.messages.slice(2).map((m) => m.type);
    expect(types).toEqual(['error', 'pong']); // the unknown type produced nothing
    expect(client.messages[2]).toMatchObject({ type: 'error', code: 'BAD_REQUEST' });
    await client.close();
  });

  it('refuses to attach a foreign session (FORBIDDEN) and routes input of an owned one', async () => {
    const client = await connect();
    client.send({
      type: 'session.attach',
      channel: 1,
      sessionId: 's-bob',
      viewport: { cols: 80, rows: 24 },
    });
    const error = await client.next((m) => m.type === 'error');
    expect(error).toEqual({
      type: 'error',
      code: 'FORBIDDEN',
      message: 'forbidden',
      sessionId: 's-bob',
      channel: 1,
    } satisfies ServerMessage);
    expect(hosts.get('s-bob')!.attached).toHaveLength(0);

    client.send({
      type: 'session.attach',
      channel: 2,
      sessionId: 's-alice',
      viewport: { cols: 100, rows: 30 },
    });
    await client.next((m) => m.type === 'session.attached');
    client.input(2, 'ls\r');
    client.input(9, 'not attached\r'); // dropped
    client.send({ type: 'ping', t: 1 });
    await client.next((m) => m.type === 'pong');
    expect(hosts.get('s-alice')!.inputs).toEqual(['ls\r']);
    // No trusted proxy configured: the socket peer is the client address of the events.
    expect(hosts.get('s-alice')!.attached[0]!.client?.ip).toBe('127.0.0.1');
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hosts.get('s-alice')!.detached).toEqual([hosts.get('s-alice')!.attached[0]!.handle.id]);
  });

  it('allows 32 channels per connection and closes with 4400 beyond', async () => {
    const client = await connect();
    for (let channel = 0; channel < 33; channel++) {
      client.send({
        type: 'session.attach',
        channel,
        sessionId: 's-alice',
        viewport: { cols: 80, rows: 24 },
      });
    }
    expect((await client.closed).code).toBe(CloseCode.BadRequest);
    expect(client.messages.filter((m) => m.type === 'session.attached')).toHaveLength(32);
  });

  it('keyboard-interactive: auth.prompt reaches every connection of the user (also later ones)', async () => {
    const prompt: ServerMessage = {
      type: 'auth.prompt',
      sessionId: 's-alice',
      promptId: 'p-1',
      name: '',
      instructions: 'MFA',
      prompts: [{ text: 'OTP: ', echo: false }],
    };
    const [tab1, tab2, bob] = await Promise.all([connect(), connect(), connect('bob')]);
    server.sendToUser('alice', prompt);
    expect(await tab1.next((m) => m.type === 'auth.prompt')).toEqual(prompt);
    expect(await tab2.next((m) => m.type === 'auth.prompt')).toEqual(prompt);
    waiting.set('alice', [prompt]); // a connection opened while the prompt waits gets it on hello
    const tab3 = await connect();
    expect(tab3.messages.map((m) => m.type)).toEqual(['hello.ok', 'sessions.list', 'auth.prompt']);
    waiting.clear();

    // Answers go to the gateway with the promptId (it discards stale ids); not for foreign sessions.
    bob.send({ type: 'auth.response', sessionId: 's-alice', promptId: 'p-1', answers: ['x'] });
    tab2.send({
      type: 'auth.response',
      sessionId: 's-alice',
      promptId: 'p-1',
      answers: ['123456'],
    });
    for (const c of [bob, tab2]) {
      c.send({ type: 'ping', t: 7 });
      await c.next((m) => m.type === 'pong');
    }
    expect(authResponses).toEqual([['s-alice', 'p-1', ['123456'], 'alice']]);
    expect(bob.messages.some((m) => m.type === 'auth.prompt')).toBe(false);
    await Promise.all([tab1, tab2, tab3, bob].map((c) => c.close()));
  });

  it('revoke() closes the matching connections with 4401', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    expect(server.revoke({ userId: 'alice' })).toBe(1);
    expect((await alice.closed).code).toBe(CloseCode.Unauthenticated);
    expect(bob.ws.readyState).toBe(bob.ws.OPEN);
    await bob.close();
  });

  it('closes the 17th concurrent connection of a user with 4429 (M4)', async () => {
    const open: TestClient[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) open.push(await connect('carol'));
    const other = await connect('bob'); // other users are not affected
    const extra = await TestClient.open(url, ORIGIN);
    extra.send({ type: 'hello', protocol: 1, ticket: ticket('carol') });
    expect((await extra.closed).code).toBe(CloseCode.RateLimited);
    // A slot frees up when one closes.
    await open.pop()!.close();
    await until(() => server.connectionCount === open.length + 1); // carol's and bob's
    open.push(await connect('carol'));
    await Promise.all([...open, other].map((c) => c.close()));
  });

  it('refuses attaches beyond 64 per user across connections, keeping the connection (M4)', async () => {
    const viewport = { cols: 80, rows: 24 };
    const attached = (c: TestClient) =>
      c.messages.filter((m) => m.type === 'session.attached').length;
    const clients: TestClient[] = [];
    for (let i = 0; i < MAX_ATTACHMENTS_PER_USER / MAX_CHANNELS; i++) {
      const client = await connect('dave');
      for (let channel = 0; channel < MAX_CHANNELS; channel++) {
        client.send({ type: 'session.attach', channel, sessionId: 's-dave', viewport });
      }
      await until(() => attached(client) === MAX_CHANNELS);
      clients.push(client);
    }
    const last = await connect('dave');
    last.send({ type: 'session.attach', channel: 1, sessionId: 's-dave', viewport });
    expect(await last.next((m) => m.type === 'error')).toMatchObject({
      code: 'RATE_LIMITED',
      channel: 1,
      sessionId: 's-dave',
    });
    expect(last.ws.readyState).toBe(last.ws.OPEN);
    // Detaching anywhere frees one.
    clients[0]!.send({ type: 'session.detach', channel: 0 });
    clients[0]!.send({ type: 'ping', t: 9 });
    await clients[0]!.next((m) => m.type === 'pong');
    last.send({ type: 'session.attach', channel: 2, sessionId: 's-dave', viewport });
    await last.next((m) => m.type === 'session.attached');
    await Promise.all([...clients, last].map((c) => c.close()));
  });

  it('closes a connection with 4429 beyond 64 messages in flight (L5)', async () => {
    const viewport = { cols: 80, rows: 24 };
    let release!: () => void;
    slowAttach = new Promise((resolve) => {
      release = resolve;
    });
    const client = await connect();
    // The attach holds the queue; 63 more messages make 64 in flight: allowed.
    client.send({ type: 'session.attach', channel: 1, sessionId: 's-slow', viewport });
    for (let i = 0; i < MAX_IN_FLIGHT - 1; i++) client.send({ type: 'ping', t: i });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await client.next((m) => m.type === 'pong' && m.t === MAX_IN_FLIGHT - 2);
    expect(client.ws.readyState).toBe(client.ws.OPEN);

    let releaseAgain!: () => void;
    slowAttach = new Promise((resolve) => {
      releaseAgain = resolve;
    });
    client.send({ type: 'session.attach', channel: 2, sessionId: 's-slow', viewport });
    for (let i = 0; i < MAX_IN_FLIGHT; i++) client.send({ type: 'ping', t: 1000 + i });
    expect((await client.closed).code).toBe(CloseCode.RateLimited);
    releaseAgain();
    slowAttach = Promise.resolve();
  });

  it("attaches to the session's current runtime when the loaded one was evicted meanwhile", async () => {
    const client = await connect();
    client.send({
      type: 'session.attach',
      channel: 5,
      sessionId: 's-evicted',
      viewport: { cols: 80, rows: 24 },
    });
    await client.next((m) => m.type === 'session.attached');
    expect(evicted.stale.attached).toHaveLength(0);
    expect(evicted.fresh.attached).toHaveLength(1);
    await client.close();
  });
});
