import { randomBytes } from 'node:crypto';
import { type ClientRequest, type IncomingHttpHeaders, request } from 'node:http';
import { type FileRequest, type ServerMessage, signTicket } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileHost } from '../../src/core/types.ts';
import { FileService } from '../../src/files/file-service.ts';
import type { FileSettings } from '../../src/files/settings.ts';
import type { AuditInput } from '../../src/store/audit.ts';
import { WsServer } from '../../src/ws/server.ts';
import type { SessionGateway } from '../../src/ws/types.ts';
import { until } from '../runtime/fakes.ts';
import { TestClient } from '../ws/client.ts';
import { MemorySftp } from './memory-sftp.ts';

const ORIGIN = 'https://termdock.test';
const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret!');
const UPLOAD_IDLE_MS = 1_000;
type Progress = Extract<ServerMessage, { type: 'transfer.progress' }>;
type FilesResult = Extract<ServerMessage, { type: 'files.result' }>;

class FakeFileHost implements FileHost {
  readonly sessionId = 'session-1';
  readonly userId = 'user-1';
  readonly serverId = 'server-1';
  fs = new MemorySftp().addDir('/data');
  ready = true;

  async sftp(): Promise<MemorySftp> {
    if (!this.ready) {
      throw new TermdockError(ErrorCode.SessionNotConnected, 'the session is not connected');
    }
    return this.fs;
  }

  closeSftp(): void {}

  async currentDirectory(): Promise<string | null> {
    return null;
  }
}

const host = new FakeFileHost();
const settings: FileSettings = { transferEnabled: true, auditEnabled: true };
const audits: AuditInput[] = [];
const invalidAuthSessions = new Set<string>();
const service = new FileService({
  sessions: { fileHost: (id) => (id === host.sessionId ? host : undefined) },
  settings: () => settings,
  audit: (input) => audits.push(input),
});
const gateway: SessionGateway = {
  host: () => undefined,
  fileHost: (id) => (id === host.sessionId ? host : undefined),
  attachable: async () => null,
  listForUser: async () => [],
  pendingPrompts: () => [],
  hostKeyDecision: async () => false,
  authResponse: () => false,
};

let server: WsServer;
let port: number;
let client: TestClient;
let requests = 0;

beforeAll(async () => {
  server = new WsServer({
    host: '127.0.0.1',
    port: 0,
    publicOrigin: ORIGIN,
    secret: SECRET,
    authSessions: { isValid: (asid) => !invalidAuthSessions.has(asid) },
    ownership: { sessionOwner: async (id) => (id === 'session-1' ? 'user-1' : null) },
    sessions: gateway,
    files: service,
    transferRoutes: { uploadIdleMs: UPLOAD_IDLE_MS },
  });
  port = (await server.listen()).port;
});

afterAll(async () => {
  await service.close();
  await server.close();
});

async function connect(): Promise<TestClient> {
  client = await TestClient.connect(
    `ws://127.0.0.1:${port}/ws`,
    ORIGIN,
    signTicket(SECRET, { uid: 'user-1', asid: 'asid-1' }),
  );
  return client;
}

afterEach(async () => {
  host.fs = new MemorySftp().addDir('/data');
  host.ready = true;
  settings.transferEnabled = true;
  invalidAuthSessions.clear();
  audits.length = 0;
  await client?.close();
});

/** A URL minted over the WebSocket, as the panel gets it. */
async function mint(fileRequest: FileRequest): Promise<{ transferId: string; url: string }> {
  const requestId = `mint-${++requests}`;
  client.send({ type: 'files.request', requestId, sessionId: 'session-1', request: fileRequest });
  const answer = await client.next(
    (m): m is FilesResult => m.type === 'files.result' && m.requestId === requestId,
  );
  if (!answer.result) throw new Error(`mint refused: ${JSON.stringify(answer.error)}`);
  return answer.result as unknown as { transferId: string; url: string };
}
const mintUpload = (name: string, size: number, overwrite = false) =>
  mint({ op: 'upload', dir: '/data', name, size, overwrite });

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Promise<Buffer>;
}

/** One HTTP request; `body` is sent and ended unless `keepOpen` (the caller drives `req`). */
function http(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Buffer,
  keepOpen = false,
): { req: ClientRequest; reply: Promise<Reply> } {
  const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false });
  const reply = new Promise<Reply>((resolve, reject) => {
    req.on('response', (res) => {
      const body = new Promise<Buffer>((done, fail) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => done(Buffer.concat(parts)));
        res.on('aborted', () => fail(new Error('response cut')));
        res.on('error', fail);
      });
      body.catch(() => {});
      resolve({ status: res.statusCode!, headers: res.headers, body });
    });
    req.on('error', reject);
  });
  reply.catch(() => {});
  if (body && !keepOpen) req.end(body);
  else if (!keepOpen) req.end();
  return { req, reply };
}

async function json(reply: Promise<Reply>): Promise<{ status: number; body: unknown }> {
  const { status, body } = await reply;
  return { status, body: JSON.parse((await body).toString('utf8')) };
}

function upload(url: string, body: Buffer, headers: Record<string, string> = { origin: ORIGIN }) {
  return http('POST', url, { 'content-type': 'application/octet-stream', ...headers }, body);
}

const progressOf = (transferId: string): Progress[] =>
  client.messages.filter(
    (m): m is Progress => m.type === 'transfer.progress' && m.transferId === transferId,
  );
const finalOf = (transferId: string) =>
  client.next(
    (m) => m.type === 'transfer.progress' && m.transferId === transferId && m.state !== 'running',
  ) as Promise<Progress>;
const tempFiles = () => host.fs.under('/data').filter((p) => p.endsWith('.part'));

describe('uploads', () => {
  it('refuse a missing or foreign Origin without spending the URL', async () => {
    await connect();
    const content = randomBytes(5_000);
    const { url } = await mintUpload('a.bin', content.length);
    const origins: Array<Record<string, string>> = [{}, { origin: 'https://evil.test' }];
    for (const headers of origins) {
      const refused = await json(upload(url, content, headers).reply);
      expect(refused).toEqual({
        status: 403,
        body: { code: ErrorCode.Forbidden, message: 'forbidden origin' },
      });
    }
    const done = await upload(url, content).reply;
    expect(done.status).toBe(200);
    expect(done.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(done.headers.vary).toBe('Origin');
    expect(done.headers['cache-control']).toBe('no-store');
    expect(JSON.parse((await done.body).toString())).toEqual({
      entry: expect.objectContaining({ name: 'a.bin', type: 'file', size: 5_000 }),
    });
  });

  it('commit atomically under the final name, with progress and an audit row', async () => {
    await connect();
    const content = randomBytes(300_000);
    const { url, transferId } = await mintUpload('report.pdf', content.length);
    const reply = upload(url, content, { origin: ORIGIN, 'user-agent': 'uploader/1.0' }).reply;
    expect((await reply).status).toBe(200);
    expect(host.fs.content('/data/report.pdf')!.equals(content)).toBe(true);
    expect(tempFiles()).toEqual([]);
    expect(host.fs.openHandles).toBe(0);
    // Written to a hidden temporary name first, then renamed into place.
    expect(host.fs.ops.find((op) => op.startsWith('open'))).toMatch(
      /^open \/data\/\.report\.pdf\.td-[0-9a-f]{8}\.part$/,
    );
    const progress = await finalOf(transferId).then(() => progressOf(transferId));
    expect(progress[0]).toMatchObject({ state: 'running', bytes: 0, size: content.length });
    expect(progress.at(-1)).toMatchObject({ state: 'done', bytes: content.length });
    expect(audits).toEqual([
      expect.objectContaining({
        type: 'file.upload',
        actorUserId: 'user-1',
        targetId: 'session-1',
        detail: { serverId: 'server-1', path: '/data/report.pdf', size: content.length },
        ip: '127.0.0.1',
        userAgent: 'uploader/1.0',
      }),
    ]);
  });

  it('refuse a used URL and a body of another size than announced', async () => {
    await connect();
    const { url } = await mintUpload('a.txt', 3);
    expect((await upload(url, Buffer.from('abc')).reply).status).toBe(200);
    expect((await json(upload(url, Buffer.from('abc')).reply)).status).toBe(403);
    const short = await mintUpload('b.txt', 10);
    expect(await json(upload(short.url, Buffer.from('abc')).reply)).toMatchObject({
      status: 400,
      body: { code: ErrorCode.BadRequest },
    });
    expect(host.fs.has('/data/b.txt')).toBe(false);
    expect(tempFiles()).toEqual([]);
  });

  it('leave no temporary file when the browser stops mid-way', async () => {
    await connect();
    const size = 2_000_000;
    const { url, transferId } = await mintUpload('big.iso', size);
    const { req } = http(
      'POST',
      url,
      { origin: ORIGIN, 'content-length': String(size) },
      undefined,
      true,
    );
    req.on('error', () => {});
    req.write(randomBytes(400_000));
    await until(() => progressOf(transferId).some((p) => p.bytes > 0), 5_000);
    req.destroy();
    expect(await finalOf(transferId)).toMatchObject({ state: 'cancelled' });
    await until(() => tempFiles().length === 0 && host.fs.openHandles === 0);
    expect(host.fs.has('/data/big.iso')).toBe(false);
  });

  it('stop an upload that sends nothing for the idle time', async () => {
    await connect();
    const { url, transferId } = await mintUpload('stalled.bin', 100_000);
    const { req, reply } = http(
      'POST',
      url,
      { origin: ORIGIN, 'content-length': '100000' },
      undefined,
      true,
    );
    req.on('error', () => {});
    req.write(randomBytes(10_000));
    expect(await finalOf(transferId)).toMatchObject({ state: 'failed', code: ErrorCode.Cancelled });
    // The answer may or may not reach a client that is still sending: when it does, it is 409.
    const answered = await Promise.race([reply.catch(() => null), Promise.resolve(null)]);
    if (answered) expect(answered.status).toBe(409);
    await until(() => tempFiles().length === 0 && host.fs.openHandles === 0);
    req.destroy();
  });

  it('replace a file keeping its permission bits, atomically when the server can', async () => {
    await connect();
    host.fs.addFile('/data/run.sh', Buffer.from('old'), 0o755);
    const { url } = await mintUpload('run.sh', 3, true);
    expect((await upload(url, Buffer.from('new')).reply).status).toBe(200);
    expect(host.fs.content('/data/run.sh')!.toString()).toBe('new');
    expect(host.fs.modeOf('/data/run.sh')).toBe(0o755);
    expect(host.fs.ops.some((op) => op.startsWith('posixRename'))).toBe(true);
    expect(host.fs.ops.some((op) => op === 'unlink /data/run.sh')).toBe(false);
  });

  it('replace by removing the old file first where posix-rename is missing', async () => {
    await connect();
    host.fs.supportsPosixRename = false;
    host.fs.addFile('/data/conf', Buffer.from('old'), 0o600);
    const { url } = await mintUpload('conf', 3, true);
    expect((await upload(url, Buffer.from('new')).reply).status).toBe(200);
    expect(host.fs.content('/data/conf')!.toString()).toBe('new');
    expect(host.fs.modeOf('/data/conf')).toBe(0o600);
    const commit = host.fs.ops.filter((op) => /^(unlink|rename|posixRename) /.test(op));
    expect(commit[0]).toBe('unlink /data/conf');
    expect(commit[1]).toMatch(/^rename \/data\/\.conf\.td-[0-9a-f]{8}\.part \/data\/conf$/);
    expect(commit).toHaveLength(2);
  });

  it('answer CONFLICT when the name appeared meanwhile, removing the temporary file', async () => {
    await connect();
    const { url } = await mintUpload('race.txt', 3);
    host.fs.addFile('/data/race.txt', Buffer.from('other'));
    expect(await json(upload(url, Buffer.from('abc')).reply)).toMatchObject({
      status: 409,
      body: { code: ErrorCode.Conflict },
    });
    expect(host.fs.content('/data/race.txt')!.toString()).toBe('other');
    expect(tempFiles()).toEqual([]);
  });

  it('take empty files', async () => {
    await connect();
    const { url } = await mintUpload('empty', 0);
    expect((await upload(url, Buffer.alloc(0)).reply).status).toBe(200);
    expect(host.fs.content('/data/empty')!.length).toBe(0);
  });

  it('answer the CORS preflight for the public origin only', async () => {
    await connect();
    const { url } = await mintUpload('x', 1);
    const ok = await http('OPTIONS', url, {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
    }).reply;
    expect(ok.status).toBe(204);
    expect(ok.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    const foreign = await http('OPTIONS', url, { origin: 'https://evil.test' }).reply;
    expect(foreign.status).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    // The preflight spends nothing.
    expect((await upload(url, Buffer.from('x')).reply).status).toBe(200);
  });
});

describe('downloads', () => {
  it('send exactly the file with the specified headers, refusing cross-site first', async () => {
    await connect();
    const content = randomBytes(200_000);
    host.fs.addFile('/data/relatório "final".pdf', content);
    const { url, transferId } = await mint({ op: 'download', path: '/data/relatório "final".pdf' });
    const refused = await json(http('GET', url, { 'sec-fetch-site': 'cross-site' }).reply);
    expect(refused).toMatchObject({ status: 403, body: { code: ErrorCode.Forbidden } });
    const reply = await http('GET', url, { 'sec-fetch-site': 'same-origin' }).reply;
    expect(reply.status).toBe(200);
    const {
      date: _date,
      connection: _connection,
      'keep-alive': _keepAlive,
      ...headers
    } = reply.headers;
    expect(headers).toEqual({
      'content-type': 'application/octet-stream',
      'content-length': String(content.length),
      'content-disposition': `attachment; filename="relat_rio \\"final\\".pdf"; filename*=UTF-8''relat%C3%B3rio%20%22final%22.pdf`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    expect((await reply.body).equals(content)).toBe(true);
    expect(await finalOf(transferId)).toMatchObject({ state: 'done', bytes: content.length });
    expect(audits).toEqual([
      expect.objectContaining({
        type: 'file.download',
        detail: { serverId: 'server-1', path: '/data/relatório "final".pdf', size: content.length },
      }),
    ]);
    expect(host.fs.openHandles).toBe(0);
    expect((await json(http('GET', url).reply)).status).toBe(403); // used
  });

  it('follow a link, send empty files, and refuse HEAD and other methods', async () => {
    await connect();
    host.fs.addFile('/data/real', Buffer.from('linked')).addLink('/data/link', 'real');
    host.fs.addFile('/data/empty', 0);
    const linked = await mint({ op: 'download', path: '/data/link' });
    const reply = await http('GET', linked.url).reply;
    expect(reply.headers['content-disposition']).toContain('filename="link"');
    expect((await reply.body).toString()).toBe('linked');
    const empty = await mint({ op: 'download', path: '/data/empty' });
    const nothing = await http('GET', empty.url, { 'sec-fetch-site': 'none' }).reply;
    expect(nothing.headers['content-length']).toBe('0');
    expect((await nothing.body).length).toBe(0);
    const other = await mint({ op: 'download', path: '/data/real' });
    const head = await http('HEAD', other.url).reply;
    expect(head.status).toBe(405);
    expect(head.headers.allow).toBe('GET');
    expect((await http('GET', other.url).reply).status).toBe(200); // HEAD spent nothing
  });

  it('cut the response of a file that shrank, never padding it', async () => {
    await connect();
    host.fs.addFile('/data/log', randomBytes(400_000));
    const { url, transferId } = await mint({ op: 'download', path: '/data/log' });
    let shrunk = false;
    // Truncated by someone else once the download started (the open handle sees it).
    host.fs.delay = (op) => {
      if (op === 'read' && !shrunk) {
        shrunk = true;
        const data = host.fs.content('/data/log')!;
        data.fill(0, 100_000);
        (host.fs.nodes.get('/data/log') as { data: Buffer }).data = data.subarray(0, 100_000);
      }
    };
    const reply = await http('GET', url).reply;
    expect(reply.headers['content-length']).toBe('400000');
    await expect(reply.body).rejects.toThrow();
    expect(await finalOf(transferId)).toMatchObject({
      state: 'failed',
      code: ErrorCode.FileOpFailed,
    });
    await until(() => host.fs.openHandles === 0);
  });
});

describe('every transfer', () => {
  it('answers 404 under /transfer and 426 elsewhere', async () => {
    expect((await http('GET', '/transfer/nope').reply).status).toBe(404);
    expect((await http('GET', '/transfer/download/a/b').reply).status).toBe(404);
    expect((await http('GET', '/other').reply).status).toBe(426);
    expect((await json(http('GET', `/transfer/download/${'x'.repeat(43)}`).reply)).status).toBe(
      403,
    );
  });

  it('needs a valid sign-in, file transfer on and a connected session', async () => {
    await connect();
    host.fs.addFile('/data/a', Buffer.from('a'));
    const signedOut = await mint({ op: 'download', path: '/data/a' });
    invalidAuthSessions.add('asid-1');
    expect((await json(http('GET', signedOut.url).reply)).status).toBe(403);
    invalidAuthSessions.clear();
    const disabled = await mint({ op: 'download', path: '/data/a' });
    settings.transferEnabled = false;
    expect(await json(http('GET', disabled.url).reply)).toMatchObject({
      status: 503,
      body: { code: ErrorCode.FilesDisabled },
    });
    settings.transferEnabled = true;
    const offline = await mint({ op: 'download', path: '/data/a' });
    host.ready = false;
    expect(await json(http('GET', offline.url).reply)).toMatchObject({
      status: 503,
      body: { code: ErrorCode.SessionNotConnected },
    });
  });

  it(`allows ${6} running transfers per user (429 beyond), and transfer.cancel stops one`, async () => {
    await connect();
    host.fs.addFile('/data/f', randomBytes(100_000));
    const gate = Promise.withResolvers<void>();
    host.fs.delay = (op) => (op === 'read' ? gate.promise : undefined);
    const minted = await Promise.all(
      Array.from({ length: 7 }, () => mint({ op: 'download', path: '/data/f' })),
    );
    const running = minted.slice(0, 6).map((m) => http('GET', m.url).reply);
    await until(() => service.transfers.running('user-1').length === 6);
    // Every response is under way (headers out, bytes held by the server).
    await Promise.all(running);
    expect(await json(http('GET', minted[6]!.url).reply)).toMatchObject({
      status: 429,
      body: { code: ErrorCode.RateLimited },
    });
    client.send({ type: 'transfer.cancel', transferId: minted[0]!.transferId });
    expect(await finalOf(minted[0]!.transferId)).toMatchObject({ state: 'cancelled' });
    gate.resolve();
    const replies = await Promise.all(running);
    await expect(replies[0]!.body).rejects.toThrow();
    for (const reply of replies.slice(1)) expect((await reply.body).length).toBe(100_000);
    await until(() => service.transfers.running().length === 0 && host.fs.openHandles === 0);
  });

  it('stops running transfers and voids unused URLs when the sign-in is revoked', async () => {
    await connect();
    host.fs.addFile('/data/f', randomBytes(100_000));
    const gate = Promise.withResolvers<void>();
    host.fs.delay = (op) => (op === 'read' ? gate.promise : undefined);
    const active = await mint({ op: 'download', path: '/data/f' });
    const unused = await mint({ op: 'download', path: '/data/f' });
    const reply = await http('GET', active.url).reply;
    await until(() => service.transfers.running('user-1').length === 1);
    const ended = service.transfers.running('user-1')[0]!;
    server.revoke({ authSessionId: 'asid-1' });
    await until(() => service.transfers.running().length === 0);
    expect(ended.state).toBe('failed');
    await expect(reply.body).rejects.toThrow();
    gate.resolve();
    await until(() => host.fs.openHandles === 0);
    expect((await json(http('GET', unused.url).reply)).status).toBe(403);
  });
});
