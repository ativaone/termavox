import { CloseCode, type ServerMessage, signTicket } from '@termdock/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeChannelMessage } from '../../src/attachments/wire.ts';
import type { AttachmentHandle, Dimensions, SessionHost } from '../../src/core/types.ts';
import { WsServer } from '../../src/ws/server.ts';
import type { SessionGateway } from '../../src/ws/types.ts';
import { TestClient } from './client.ts';

const ORIGIN = 'https://termdock.test';
const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret!');

class FakeHost implements SessionHost {
  readonly sessionId: string;
  readonly attached: Array<{ handle: AttachmentHandle; viewport: Dimensions }> = [];
  readonly inputs: string[] = [];
  readonly detached: string[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async start(): Promise<void> {}
  attach(handle: AttachmentHandle, viewport: Dimensions): void {
    this.attached.push({ handle, viewport });
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
]);
const owners = new Map([
  ['s-alice', 'alice'],
  ['s-bob', 'bob'],
]);
const invalidAuthSessions = new Set<string>(['asid-revoked']);

const gateway: SessionGateway = {
  host: (id) => hosts.get(id),
  attachable: async (id) => hosts.get(id) ?? null,
  listForUser: async () => [],
  pendingPrompts: () => [],
  hostKeyDecision: async () => false,
  authResponse: () => false,
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

  it('revoke() closes the matching connections with 4401', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    expect(server.revoke({ userId: 'alice' })).toBe(1);
    expect((await alice.closed).code).toBe(CloseCode.Unauthenticated);
    expect(bob.ws.readyState).toBe(bob.ws.OPEN);
    await bob.close();
  });
});
