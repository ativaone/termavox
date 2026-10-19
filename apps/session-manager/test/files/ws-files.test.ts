import {
  FILES_LIMITS,
  type FileRequest,
  type FileResult,
  type ServerMessage,
  signTicket,
} from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeChannelMessage } from '../../src/attachments/wire.ts';
import type { AttachmentHandle, Dimensions, SessionHost } from '../../src/core/types.ts';
import { WsServer } from '../../src/ws/server.ts';
import type { FileGateway, FileRequestContext, SessionGateway } from '../../src/ws/types.ts';
import { until } from '../runtime/fakes.ts';
import { TestClient } from '../ws/client.ts';

const ORIGIN = 'https://termdock.test';
const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret!');

class FakeHost implements SessionHost {
  readonly sessionId: string;
  readonly inputs: string[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async start(): Promise<void> {}
  attach(handle: AttachmentHandle, viewport: Dimensions): void {
    handle.send(
      encodeChannelMessage({
        type: 'session.attached',
        sessionId: this.sessionId,
        ...viewport,
        scrollbackLines: 1000,
      }),
    );
  }
  detach(): void {}
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

/** Requests stay pending until the test releases them, or end CANCELLED when aborted. */
class FakeFiles implements FileGateway {
  readonly calls: Array<{ context: FileRequestContext; request: FileRequest }> = [];
  readonly cancels: Array<[string, string]> = [];
  readonly #release = new Map<string, () => void>();

  handle(context: FileRequestContext, request: FileRequest): Promise<FileResult> {
    this.calls.push({ context, request });
    if (request.op === 'open') return Promise.resolve({ op: 'open', home: '/home/a', cwd: null });
    return new Promise((resolve, reject) => {
      this.#release.set(context.requestId, () =>
        resolve({ op: 'list', path: '/', entries: [], truncated: false }),
      );
      context.signal.addEventListener('abort', () =>
        reject(new TermdockError(ErrorCode.Cancelled, 'cancelled')),
      );
    });
  }

  release(requestId: string): void {
    this.#release.get(requestId)?.();
  }

  cancelTransfer(userId: string, transferId: string): void {
    this.cancels.push([userId, transferId]);
  }
}

const host = new FakeHost('s-alice');
const owners = new Map([
  ['s-alice', 'alice'],
  ['s-bob', 'bob'],
]);
const files = new FakeFiles();
const gateway: SessionGateway = {
  host: (id) => (id === 's-alice' ? host : undefined),
  fileHost: () => undefined,
  attachable: async (id) => (id === 's-alice' ? host : null),
  listForUser: async () => [],
  pendingPrompts: () => [],
  hostKeyDecision: async () => false,
  authResponse: () => false,
};

let server: WsServer;
let url: string;

const connect = (uid = 'alice'): Promise<TestClient> =>
  TestClient.connect(url, ORIGIN, signTicket(SECRET, { uid, asid: `asid-${uid}` }));
const list = (requestId: string, sessionId = 's-alice') => ({
  type: 'files.request' as const,
  requestId,
  sessionId,
  request: { op: 'list' as const, path: '/slow' },
});
const resultOf = (client: TestClient, requestId: string) =>
  client.next(
    (m): m is Extract<ServerMessage, { type: 'files.result' }> =>
      m.type === 'files.result' && m.requestId === requestId,
  );
const callsOf = (requestId: string) => files.calls.filter((c) => c.context.requestId === requestId);

beforeAll(async () => {
  server = new WsServer({
    host: '127.0.0.1',
    port: 0,
    publicOrigin: ORIGIN,
    secret: SECRET,
    authSessions: { isValid: () => true },
    ownership: { sessionOwner: async (id) => owners.get(id) ?? null },
    sessions: gateway,
    files,
  });
  url = `ws://127.0.0.1:${(await server.listen()).port}/ws`;
});

afterAll(async () => {
  await server.close();
});

describe('file requests over the WebSocket (plan §5.12)', () => {
  it('never holds the connection: a ping and keystrokes pass a slow request', async () => {
    const client = await connect();
    client.send({
      type: 'session.attach',
      channel: 1,
      sessionId: 's-alice',
      viewport: { cols: 80, rows: 24 },
    });
    await client.next((m) => m.type === 'session.attached');
    client.send(list('slow-1'));
    client.send({ type: 'ping', t: 7 });
    client.input(1, 'typed while listing');
    expect(await client.next((m) => m.type === 'pong')).toEqual({ type: 'pong', t: 7 });
    await until(() => host.inputs.includes('typed while listing'));
    expect(client.messages.some((m) => m.type === 'files.result')).toBe(false);

    // The request reached the service with the connection's identity and client.
    await until(() => callsOf('slow-1').length === 1);
    const { context } = callsOf('slow-1')[0]!;
    expect(context).toMatchObject({ userId: 'alice', sessionId: 's-alice' });
    expect(context.client.ip).toBe('127.0.0.1');
    files.release('slow-1');
    expect(await resultOf(client, 'slow-1')).toMatchObject({ result: { op: 'list' } });
    await client.close();
  });

  it(`answers the request beyond ${FILES_LIMITS.requestsInFlight} in flight RATE_LIMITED`, async () => {
    const client = await connect();
    const ids = Array.from({ length: FILES_LIMITS.requestsInFlight + 1 }, (_, i) => `rl-${i}`);
    for (const id of ids) client.send(list(id));
    const refused = await resultOf(client, ids.at(-1)!);
    expect(refused.error?.code).toBe(ErrorCode.RateLimited);
    expect(refused.result).toBeUndefined();
    await until(() => ids.slice(0, -1).every((id) => callsOf(id).length === 1));
    expect(callsOf(ids.at(-1)!)).toEqual([]);

    // One finishes: the next is accepted.
    files.release('rl-0');
    await resultOf(client, 'rl-0');
    client.send(list('rl-next'));
    await until(() => callsOf('rl-next').length === 1);
    for (const id of [...ids.slice(1, -1), 'rl-next']) files.release(id);
    await resultOf(client, 'rl-next');
    await client.close();
  });

  it("refuses another user's session or an unknown one with a files.result FORBIDDEN", async () => {
    const client = await connect();
    client.send(list('foreign', 's-bob'));
    client.send(list('unknown', 's-none'));
    for (const id of ['foreign', 'unknown']) {
      expect(await resultOf(client, id)).toEqual({
        type: 'files.result',
        requestId: id,
        error: { code: ErrorCode.Forbidden, message: 'forbidden' },
      });
    }
    expect(callsOf('foreign')).toEqual([]);
    expect(callsOf('unknown')).toEqual([]);
    await client.close();
  });

  it('cancels a request on files.cancel, and every running one when the connection closes', async () => {
    const client = await connect();
    client.send(list('to-cancel'));
    await until(() => callsOf('to-cancel').length === 1);
    client.send({ type: 'files.cancel', requestId: 'to-cancel' });
    expect((await resultOf(client, 'to-cancel')).error?.code).toBe(ErrorCode.Cancelled);

    client.send(list('orphan'));
    await until(() => callsOf('orphan').length === 1);
    await client.close();
    await until(() => callsOf('orphan')[0]!.context.signal.aborted);
  });

  it('hands transfer.cancel to the file service, and refuses an unknown op as malformed', async () => {
    const client = await connect();
    client.send({ type: 'transfer.cancel', transferId: 't-1' });
    await until(() => files.cancels.length === 1);
    expect(files.cancels).toEqual([['alice', 't-1']]);
    client.send({ ...list('bad-op'), request: { op: 'chmod', path: '/x' } });
    expect(await client.next((m) => m.type === 'error')).toMatchObject({
      code: ErrorCode.BadRequest,
    });
    client.send({
      type: 'files.request',
      requestId: 'open-1',
      sessionId: 's-alice',
      request: { op: 'open' },
    });
    expect((await resultOf(client, 'open-1')).result).toEqual({
      op: 'open',
      home: '/home/a',
      cwd: null,
    });
    expect(client.messages.some((m) => m.type === 'files.result' && m.requestId === 'bad-op')).toBe(
      false,
    );
    await client.close();
  });
});

describe('without a file service', () => {
  it('answers every file request FILES_DISABLED', async () => {
    const bare = new WsServer({
      host: '127.0.0.1',
      port: 0,
      publicOrigin: ORIGIN,
      secret: SECRET,
      authSessions: { isValid: () => true },
      ownership: { sessionOwner: async (id) => owners.get(id) ?? null },
      sessions: gateway,
    });
    const port = (await bare.listen()).port;
    const client = await TestClient.connect(
      `ws://127.0.0.1:${port}/ws`,
      ORIGIN,
      signTicket(SECRET, { uid: 'alice', asid: 'asid-alice' }),
    );
    client.send(list('nofiles'));
    expect((await resultOf(client, 'nofiles')).error?.code).toBe(ErrorCode.FilesDisabled);
    await client.close();
    await bare.close();
  });
});
