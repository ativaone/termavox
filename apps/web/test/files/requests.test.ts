import type { ClientMessage, ServerMessage } from '@termavox/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRequests } from '../../lib/files/requests.ts';
import { TermavoxConnection } from '../../lib/terminal/index.ts';
import { FakeServer, sleep, until } from '../terminal/helpers.ts';

type FilesRequest = Extract<ClientMessage, { type: 'files.request' }>;

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

async function connected(timeoutMs = 30_000) {
  const server = new FakeServer();
  const connection = new TermavoxConnection({
    url: 'ws://termavox.test/ws',
    fetchTicket: async () => ({ ticket: 't', expiresAt: Date.now() + 30_000 }),
    createWebSocket: server.createWebSocket,
    backoff: { initialMs: 5, maxMs: 20, jitter: 0 },
    pingIntervalMs: 60_000,
    fileRequestTimeoutMs: timeoutMs,
  });
  cleanup.push(() => connection.close());
  connection.connect();
  await until(() => connection.getSnapshot().status === 'open');
  const sent = () =>
    server.last.control.filter((m): m is FilesRequest => m.type === 'files.request');
  const reply = (message: ServerMessage) => server.last.deliver(JSON.stringify(message));
  return { server, connection, sent, reply };
}

const entry = { name: 'app', type: 'dir', size: 4096, mtime: 1, mode: 0o755 } as const;

describe('file requests over the tab connection (plan §5.12)', () => {
  it('matches each result to its request by requestId, in any order', async () => {
    const { connection, sent, reply } = await connected();
    const opened = connection.fileRequest('s1', { op: 'open' });
    const listed = connection.fileRequest('s1', { op: 'list', path: '/srv' });
    const [first, second] = sent();
    expect(first).toMatchObject({ sessionId: 's1', request: { op: 'open' } });
    expect(second).toMatchObject({ sessionId: 's1', request: { op: 'list', path: '/srv' } });
    expect(first!.requestId).not.toBe(second!.requestId);
    expect(first!.requestId.length).toBeLessThanOrEqual(64);

    reply({
      type: 'files.result',
      requestId: second!.requestId,
      result: { op: 'list', path: '/srv', entries: [entry], truncated: false },
    });
    reply({
      type: 'files.result',
      requestId: first!.requestId,
      result: { op: 'open', home: '/home/tv', cwd: null },
    });
    await expect(listed).resolves.toMatchObject({ op: 'list', entries: [entry] });
    await expect(opened).resolves.toEqual({ op: 'open', home: '/home/tv', cwd: null });
  });

  it("rejects with the daemon's code, and with INTERNAL for a result of another op", async () => {
    const { connection, sent, reply } = await connected();
    const denied = connection.fileRequest('s1', { op: 'mkdir', path: '/root/x' });
    const odd = connection.fileRequest('s1', { op: 'mkdir', path: '/tmp/x' });
    const [a, b] = sent();
    reply({
      type: 'files.result',
      requestId: a!.requestId,
      error: { code: 'PERMISSION_DENIED', message: 'permission denied' },
    });
    reply({
      type: 'files.result',
      requestId: b!.requestId,
      result: { op: 'remove', removed: 1 },
    });
    await expect(denied).rejects.toMatchObject({
      name: 'FileRequestError',
      code: 'PERMISSION_DENIED',
      message: 'permission denied',
    });
    await expect(odd).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('times out without an answer and drops the late one', async () => {
    const { connection, sent, reply } = await connected(20);
    const listed = connection.fileRequest('s1', { op: 'list', path: '/' });
    await expect(listed).rejects.toMatchObject({ code: 'TIMEOUT' });
    // The late answer is ignored (no throw, nothing pending).
    reply({
      type: 'files.result',
      requestId: sent()[0]!.requestId,
      result: { op: 'list', path: '/', entries: [], truncated: false },
    });
  });

  it('reports remove progress, never times out while it does, and cancels on abort', async () => {
    const { connection, server, sent, reply } = await connected(30);
    const progress: number[] = [];
    const controller = new AbortController();
    const removing = connection.fileRequest(
      's1',
      { op: 'remove', paths: ['/srv/big'] },
      { signal: controller.signal, onProgress: (removed) => progress.push(removed) },
    );
    const requestId = sent()[0]!.requestId;
    reply({ type: 'files.progress', requestId, removed: 10 });
    await sleep(60); // twice the timeout: still waiting
    reply({ type: 'files.progress', requestId, removed: 25 });
    controller.abort();
    expect(server.last.control.at(-1)).toEqual({ type: 'files.cancel', requestId });
    reply({
      type: 'files.result',
      requestId,
      error: { code: 'CANCELLED', message: 'cancelled' },
    });
    await expect(removing).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(progress).toEqual([10, 25]);
  });

  it('rejects requests in flight with CONNECTION_LOST when the socket drops, and refuses offline', async () => {
    const { connection, server } = await connected();
    const pending = connection.fileRequest('s1', { op: 'open' });
    let dropped = 0;
    const off = connection.subscribeTransfers({
      progress: () => {},
      disconnected: () => dropped++,
    });
    cleanup.push(off);
    server.last.serverClose(1006);
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(dropped).toBe(1);
    // Not connected (reconnecting): refused at once, nothing queued for later.
    await expect(connection.fileRequest('s1', { op: 'open' })).rejects.toMatchObject({
      code: 'CONNECTION_LOST',
    });
  });

  it('routes transfer progress to subscribers and sends transfer.cancel', async () => {
    const { connection, server, reply } = await connected();
    const seen: unknown[] = [];
    const off = connection.subscribeTransfers({ progress: (m) => seen.push(m) });
    const message = {
      type: 'transfer.progress',
      transferId: 'x1',
      bytes: 10,
      size: 20,
      state: 'running',
    } as const;
    reply(message);
    off();
    reply({ ...message, bytes: 20, state: 'done' });
    expect(seen).toEqual([message]);
    expect(connection.cancelTransfer('x1')).toBe(true);
    expect(server.last.control.at(-1)).toEqual({ type: 'transfer.cancel', transferId: 'x1' });
  });
});

describe('FileRequests on its own', () => {
  it('refuses an already aborted request without sending it', async () => {
    const sent: ClientMessage[] = [];
    const files = new FileRequests({ send: (m) => sent.push(m) > 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      files.fileRequest('s1', { op: 'open' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sent).toEqual([]);
    expect(files.pending).toBe(0);
  });

  it('ignores progress and results for unknown requests, and passes on other messages', () => {
    const files = new FileRequests({ send: () => true });
    expect(files.handle({ type: 'files.progress', requestId: 'nope', removed: 1 })).toBe(true);
    expect(files.handle({ type: 'pong', t: 1 })).toBe(false);
  });
});
