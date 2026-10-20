import { randomBytes } from 'node:crypto';
import {
  type ClientRequest,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
} from 'node:http';
import {
  type FileRequest,
  type ServerMessage,
  signTicket,
  TRANSFER_PATH,
} from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FileHost, SftpError, SftpStatus } from '../../src/core/types.ts';
import { FileService } from '../../src/files/file-service.ts';
import type { FileSettings } from '../../src/files/settings.ts';
import { TransferRoutes, type TransferRoutesOptions } from '../../src/files/transfer-routes.ts';
import type { TransferGrantInput } from '../../src/files/transfer-tokens.ts';
import type { AuditInput } from '../../src/store/audit.ts';
import { TrustedProxies } from '../../src/ws/client-ip.ts';
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

/**
 * One HTTP request; `body` is sent and ended unless `keepOpen` (the caller drives `req`). `to` is
 * the listener's port (default: the WebSocket server's).
 */
function http(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Buffer,
  keepOpen = false,
  to = port,
): { req: ClientRequest; reply: Promise<Reply> } {
  const req = request({ host: '127.0.0.1', port: to, method, path, headers, agent: false });
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

function upload(
  url: string,
  body: Buffer,
  headers: Record<string, string> = { origin: ORIGIN },
  to = port,
) {
  return http(
    'POST',
    url,
    { 'content-type': 'application/octet-stream', ...headers },
    body,
    false,
    to,
  );
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

/**
 * The permission bits of an upload's temporary file when the server created it (seen as the mode
 * is set through the handle) and just before the first write reaches it.
 */
function watchModes(fs: MemorySftp): { created: number | null; firstWrite: number | null } {
  const seen = { created: null as number | null, firstWrite: null as number | null };
  fs.delay = (op, path) => {
    if (op === 'fchmod' && seen.created === null) seen.created = fs.modeOf(path);
    if (op === 'write' && seen.firstWrite === null) seen.firstWrite = fs.modeOf(path);
  };
  return seen;
}
const opIndex = (fs: MemorySftp, prefix: string) => fs.ops.findIndex((op) => op.startsWith(prefix));

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
    // A new file keeps the server's default permissions (like scp or touch).
    expect(host.fs.modeOf('/data/report.pdf')).toBe(0o644);
    expect(opIndex(host.fs, 'fchmod')).toBe(-1);
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

  it("write a replacement only under the old file's bits, set through the handle", async () => {
    // Regression: the temporary file was created with the server's default mode (0644 here) and
    // chmod'ed by path at the commit, so a 0600 secret was readable by others while it uploaded.
    await connect();
    host.fs.addFile('/data/id_ed25519', Buffer.from('old'), 0o600);
    const seen = watchModes(host.fs);
    const { url } = await mintUpload('id_ed25519', 3, true);
    expect((await upload(url, Buffer.from('new')).reply).status).toBe(200);
    expect(seen).toEqual({ created: 0o600, firstWrite: 0o600 });
    expect(host.fs.modeOf('/data/id_ed25519')).toBe(0o600);
    expect(opIndex(host.fs, 'open')).toBeLessThan(opIndex(host.fs, 'fchmod'));
    expect(opIndex(host.fs, 'fchmod')).toBeLessThan(opIndex(host.fs, 'write'));
    // Nothing by path: a link swapped in for the temporary file is never followed.
    expect(host.fs.ops.filter((op) => op.startsWith('chmod '))).toEqual([]);
  });

  it('set the exact bits whatever the umask, and setuid once the content is complete', async () => {
    await connect();
    host.fs.umask = 0o077;
    host.fs.addFile('/data/shared.txt', Buffer.from('old'), 0o644);
    const shared = watchModes(host.fs);
    const first = await mintUpload('shared.txt', 3, true);
    expect((await upload(first.url, Buffer.from('new')).reply).status).toBe(200);
    // Created narrower by the umask, widened to the old bits before the first byte.
    expect(shared).toEqual({ created: 0o600, firstWrite: 0o644 });
    expect(host.fs.modeOf('/data/shared.txt')).toBe(0o644);

    // A write clears setuid (and a half-written setuid file must never exist): it goes on last.
    host.fs.umask = 0o022;
    host.fs.addFile('/data/tool', Buffer.from('old'), 0o4755);
    const tool = watchModes(host.fs);
    const second = await mintUpload('tool', 3, true);
    expect((await upload(second.url, Buffer.from('new')).reply).status).toBe(200);
    expect(tool).toEqual({ created: 0o755, firstWrite: 0o755 });
    expect(host.fs.modeOf('/data/tool')).toBe(0o4755);
    expect(host.fs.ops.filter((op) => op.startsWith('chmod '))).toEqual([]);
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

  it('answer CONFLICT before writing anything when the name appeared since the minting', async () => {
    await connect();
    const { url } = await mintUpload('race.txt', 3);
    host.fs.addFile('/data/race.txt', Buffer.from('other'));
    expect(await json(upload(url, Buffer.from('abc')).reply)).toMatchObject({
      status: 409,
      body: { code: ErrorCode.Conflict },
    });
    expect(host.fs.content('/data/race.txt')!.toString()).toBe('other');
    // Checked as the upload starts (the bits to keep are read then): no temporary file was made.
    expect(opIndex(host.fs, 'open')).toBe(-1);
  });

  it('answer CONFLICT when the name appears during the upload, removing the temporary file', async () => {
    await connect();
    // During the writes, the commit's check finds it; between that check and the rename, the
    // server refuses the rename (OpenSSH: a generic FAILURE), and the name is looked up again.
    for (const appearsOn of ['write', 'rename']) {
      host.fs = new MemorySftp().addDir('/data');
      const fs = host.fs;
      fs.delay = (op) => {
        if (op === appearsOn && !fs.has('/data/race.txt')) {
          fs.addFile('/data/race.txt', Buffer.from('other'));
        }
      };
      const { url } = await mintUpload('race.txt', 3);
      expect(await json(upload(url, Buffer.from('abc')).reply)).toMatchObject({
        status: 409,
        body: { code: ErrorCode.Conflict },
      });
      expect(fs.content('/data/race.txt')!.toString()).toBe('other');
      expect(fs.ops.some((op) => /^rename \/data\/\.race\.txt\.td-/.test(op))).toBe(
        appearsOn === 'rename',
      );
      expect(tempFiles()).toEqual([]);
      expect(fs.openHandles).toBe(0);
    }
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
  it('send exactly the file with the specified headers, from any site', async () => {
    await connect();
    const content = randomBytes(200_000);
    host.fs.addFile('/data/relatório "final".pdf', content);
    const { url, transferId } = await mint({ op: 'download', path: '/data/relatório "final".pdf' });
    const reply = await http('GET', url, { 'sec-fetch-site': 'cross-site' }).reply;
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
      'cross-origin-resource-policy': 'same-origin',
    });
    expect((await reply.body).equals(content)).toBe(true);
    expect(await finalOf(transferId)).toMatchObject({ state: 'done', bytes: content.length });
    await until(() => audits.length > 0);
    expect(audits).toEqual([
      expect.objectContaining({
        type: 'file.download',
        detail: {
          serverId: 'server-1',
          path: '/data/relatório "final".pdf',
          size: content.length,
          bytes: content.length,
          completed: true,
        },
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

  it('stop cleanly when the browser leaves before the first byte', async () => {
    // Regression: the client left while the file was being opened, so the response was already
    // destroyed when the bytes were to be piped into it. The reader then kept reading after the
    // handle was closed, and its read failure was an unhandled 'error' that ended the daemon.
    await connect();
    host.fs.addFile('/data/early', randomBytes(600_000));
    const { url, transferId } = await mint({ op: 'download', path: '/data/early' });
    const gate = Promise.withResolvers<void>();
    let held = false;
    host.fs.delay = async (op) => {
      if (op === 'fstat' && !held) {
        held = true;
        await gate.promise;
      }
    };
    const { req } = http('GET', url);
    await until(() => held);
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.resolve();
    expect(await finalOf(transferId)).toMatchObject({ state: 'cancelled' });
    await until(() => host.fs.openHandles === 0);
    // Reads that would have run on the closed handle had 100 ms to fail the process.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.fs.ops.filter((op) => op.startsWith('read'))).toEqual([]);
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
    const end = await finalOf(transferId);
    expect(end).toMatchObject({ state: 'failed', code: ErrorCode.FileOpFailed });
    expect(end.bytes).toBeGreaterThan(0);
    expect(end.bytes).toBeLessThanOrEqual(100_000);
    await until(() => host.fs.openHandles === 0 && audits.length > 0);
    // Regression: the row was written before a byte went out, with the size only.
    expect(audits).toEqual([
      expect.objectContaining({
        type: 'file.download',
        detail: {
          serverId: 'server-1',
          path: '/data/log',
          size: 400_000,
          bytes: end.bytes,
          completed: false,
        },
      }),
    ]);
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
    // Nothing went out: no download row.
    expect(audits).toEqual([]);
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

  it('frees the slot of a download cancelled while the server sits on its open', async () => {
    // Regression: the open was not raced with the cancel, so the slot stayed taken for as long
    // as the server did not answer.
    await connect();
    host.fs.addFile('/data/f', randomBytes(1_000));
    const gate = Promise.withResolvers<void>();
    host.fs.delay = (op) => (op === 'open' ? gate.promise : undefined);
    const { url, transferId } = await mint({ op: 'download', path: '/data/f' });
    const reply = http('GET', url).reply;
    await until(() => opIndex(host.fs, 'open') >= 0);
    client.send({ type: 'transfer.cancel', transferId });
    expect(await finalOf(transferId)).toMatchObject({ state: 'cancelled' });
    expect(service.transfers.running('user-1')).toEqual([]);
    expect((await json(reply)).status).toBe(409);
    // The handle the server hands out late is closed.
    gate.resolve();
    await until(() => host.fs.ops.includes('close /data/f') && host.fs.openHandles === 0);
  });

  it('frees the slot of an upload revoked while the server sits on its open', async () => {
    await connect();
    const gate = Promise.withResolvers<void>();
    host.fs.delay = (op) => (op === 'open' ? gate.promise : undefined);
    const { url } = await mintUpload('late.bin', 3);
    const reply = upload(url, Buffer.from('abc')).reply;
    await until(() => opIndex(host.fs, 'open') >= 0);
    server.revoke({ authSessionId: 'asid-1' });
    await until(() => service.transfers.running().length === 0);
    expect(await json(reply)).toMatchObject({
      status: 401,
      body: { code: ErrorCode.Unauthenticated },
    });
    // The temporary file the server creates late is closed and removed.
    gate.resolve();
    await until(
      () =>
        host.fs.ops.some((op) => /^unlink \/data\/\.late\.bin\.td-/.test(op)) &&
        tempFiles().length === 0 &&
        host.fs.openHandles === 0,
    );
  });
});

describe('transfer routes on a listener of their own', () => {
  // The WebSocket server fixes the download idle time and the revalidation interval: these
  // tests shorten them on routes of their own.
  type Timings = Pick<TransferRoutesOptions, 'downloadIdleMs' | 'revalidateIntervalMs'>;
  interface Bench {
    port: number;
    host: FakeFileHost;
    service: FileService;
    told: ServerMessage[];
    logs: string[];
    /** What the auth-session check answers (an Error: it throws), and how often it ran. */
    validity: { answer: boolean | Error; checks: number };
    mint(input: DirectGrant): { url: string; transferId: string };
  }
  type DirectGrant =
    | { direction: 'download'; path: string; size: number }
    | { direction: 'upload'; name: string; size: number };
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function bench(timings: Timings = {}): Promise<Bench> {
    const benchHost = new FakeFileHost();
    const benchService = new FileService({
      sessions: { fileHost: (id) => (id === benchHost.sessionId ? benchHost : undefined) },
      settings: () => settings,
      audit: (input) => audits.push(input),
    });
    const told: ServerMessage[] = [];
    const logs: string[] = [];
    const validity: Bench['validity'] = { answer: true, checks: 0 };
    const routes = new TransferRoutes({
      publicOrigin: ORIGIN,
      authSessions: {
        isValid: async () => {
          validity.checks++;
          if (validity.answer instanceof Error) throw validity.answer;
          return validity.answer;
        },
      },
      trustedProxies: new TrustedProxies([]),
      backend: benchService,
      logger: pino({ level: 'info' }, { write: (line: string) => logs.push(line) }),
      uploadIdleMs: UPLOAD_IDLE_MS,
      ...timings,
    });
    const listener = createServer((req, res) => routes.handle(req, res));
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    closers.push(async () => {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
      await benchService.close();
    });
    const address = listener.address();
    return {
      port: typeof address === 'object' && address ? address.port : 0,
      host: benchHost,
      service: benchService,
      told,
      logs,
      validity,
      mint(input) {
        const bound = {
          userId: 'user-1',
          authSessionId: 'asid-1',
          sessionId: benchHost.sessionId,
          notify: (m: ServerMessage) => told.push(m),
          client: {},
        };
        const grantInput: TransferGrantInput =
          input.direction === 'download'
            ? { ...bound, ...input }
            : {
                ...bound,
                ...input,
                dir: '/data',
                path: `/data/${input.name}`,
                overwrite: false,
              };
        const { token, grant } = benchService.transfers.mint(grantInput);
        return {
          url: `${TRANSFER_PATH}/${input.direction}/${token}`,
          transferId: grant.transferId,
        };
      },
    };
  }

  const endOf = (b: Bench, transferId: string) =>
    b.told.find(
      (m): m is Progress =>
        m.type === 'transfer.progress' && m.transferId === transferId && m.state !== 'running',
    );

  it('stop a download the browser stopped taking, freeing its slot and its handle', async () => {
    // Regression: a client that stopped reading held its slot, the remote handle and the
    // session's channel until the SSH connection ended.
    const b = await bench({ downloadIdleMs: 300 });
    // Larger than what the loopback socket buffers absorb.
    const size = 24 * 1024 * 1024;
    b.host.fs.addFile('/data/big', size);
    const { url, transferId } = b.mint({ direction: 'download', path: '/data/big', size });
    const req = request({ host: '127.0.0.1', port: b.port, path: url, agent: false });
    req.on('error', () => {});
    req.end();
    const res = await new Promise<IncomingMessage>((resolve) => req.on('response', resolve));
    res.on('error', () => {});
    res.pause(); // never read
    await until(() => endOf(b, transferId) !== undefined, 4_000);
    expect(endOf(b, transferId)).toMatchObject({ state: 'failed', code: ErrorCode.Cancelled });
    expect(b.service.transfers.running()).toEqual([]);
    await until(() => b.host.fs.openHandles === 0);
    req.destroy();
  });

  it('keep a download going while its chunks flow, however long it takes in all', async () => {
    // The idle time counts from the last chunk the response took, not from the start: a steady
    // download that outlasts it many times over ends complete.
    const idleMs = 300;
    const b = await bench({ downloadIdleMs: idleMs });
    const size = 40 * 32 * 1024; // 40 reads
    const content = randomBytes(size);
    b.host.fs.addFile('/data/slow', content);
    // One read answered every 30 ms, however many the reader has in flight: about 1.2 s in all.
    let pace = Promise.resolve();
    b.host.fs.delay = (op) => {
      if (op !== 'read') return;
      pace = pace.then(() => new Promise((resolve) => setTimeout(resolve, 30)));
      return pace;
    };
    const { url, transferId } = b.mint({ direction: 'download', path: '/data/slow', size });
    const started = performance.now();
    const reply = await http('GET', url, {}, undefined, false, b.port).reply;
    expect((await reply.body).equals(content)).toBe(true);
    expect(performance.now() - started).toBeGreaterThan(3 * idleMs);
    await until(() => endOf(b, transferId) !== undefined);
    expect(endOf(b, transferId)).toMatchObject({ state: 'done', bytes: size });
  });

  it('stop running transfers whose sign-in is no longer valid, on the next check', async () => {
    // Regression: only an explicit revoke stopped an HTTP transfer; one that never reached the
    // daemon left it running (WebSocket connections had this check already).
    const b = await bench({ revalidateIntervalMs: 50 });
    b.host.fs.addFile('/data/f', randomBytes(100_000));
    const gate = Promise.withResolvers<void>();
    b.host.fs.delay = (op) => (op === 'read' ? gate.promise : undefined);
    const active = b.mint({ direction: 'download', path: '/data/f', size: 100_000 });
    const unused = b.mint({ direction: 'download', path: '/data/f', size: 100_000 });
    const reply = await http('GET', active.url, {}, undefined, false, b.port).reply;
    await until(() => b.service.transfers.running().length === 1);
    b.validity.answer = false;
    await until(() => b.service.transfers.running().length === 0);
    expect(endOf(b, active.transferId)).toMatchObject({
      state: 'failed',
      code: ErrorCode.Unauthenticated,
    });
    await expect(reply.body).rejects.toThrow();
    gate.resolve();
    await until(() => b.host.fs.openHandles === 0);
    // Its unused URLs went with it.
    b.validity.answer = true;
    expect((await json(http('GET', unused.url, {}, undefined, false, b.port).reply)).status).toBe(
      403,
    );
  });

  it('ride out a check that fails, and stop after three failures in a row', async () => {
    const b = await bench({ revalidateIntervalMs: 60 });
    b.host.fs.addFile('/data/f', randomBytes(100_000));
    const gate = Promise.withResolvers<void>();
    b.host.fs.delay = (op) => (op === 'read' ? gate.promise : undefined);
    const { url, transferId } = b.mint({ direction: 'download', path: '/data/f', size: 100_000 });
    const reply = await http('GET', url, {}, undefined, false, b.port).reply;
    await until(() => b.service.transfers.running().length === 1);
    const before = b.validity.checks;
    b.validity.answer = new Error('the store did not answer');
    await until(() => b.validity.checks >= before + 2);
    expect(b.service.transfers.running()).toHaveLength(1);
    await until(() => b.service.transfers.running().length === 0);
    expect(b.validity.checks).toBeGreaterThanOrEqual(before + 3);
    expect(endOf(b, transferId)).toMatchObject({
      state: 'failed',
      code: ErrorCode.Unauthenticated,
    });
    await expect(reply.body).rejects.toThrow();
    gate.resolve();
  });

  it("log a server's words only cleaned (no bidi or C1 control characters)", async () => {
    const b = await bench();
    const hostile = 'nope\u202e\x9b[31m\u200bgone';
    b.host.fs.delay = (op) => {
      if (op === 'write' || op === 'close' || op === 'unlink') {
        throw new SftpError(SftpStatus.Failure, hostile);
      }
    };
    const { url } = b.mint({ direction: 'upload', name: 'a.txt', size: 3 });
    const reply = await json(upload(url, Buffer.from('abc'), { origin: ORIGIN }, b.port).reply);
    expect(reply).toMatchObject({ status: 502, body: { code: ErrorCode.FileOpFailed } });
    await until(() => b.logs.some((line) => line.includes('temporary upload file not removed')));
    const logged = b.logs.join('');
    expect(logged).toContain('nope[31mgone');
    expect(logged).not.toMatch(/[\u202e\u200b\x9b]/);
  });
});
