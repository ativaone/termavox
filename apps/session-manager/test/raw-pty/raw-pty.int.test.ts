// T1: unprotected (raw PTY) sessions over the real WebSocket server against the no-tmux sshd.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { signTicket } from '@termavox/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPlane, type DataPlane } from '../../src/core/data-plane.ts';
import type { SessionRuntime } from '../../src/core/session-runtime.ts';
import { TargetPolicy } from '../../src/transport/ssh/index.ts';
import { diff, probe } from '../emulator/harness.ts';
import { MemoryHostKeyStore, MemorySessionStore, makeRecord, until } from '../runtime/fakes.ts';
import { HOST_KEY, requireSshd, SSHD_PORTS, TEST_USER, USER_KEY } from '../ssh/sshd.ts';
import { TestClient } from '../ws/client.ts';

const ORIGIN = 'https://termavox.test';
const SECRET = new TextEncoder().encode('t1-secret-t1-secret-t1-secret-t1!');
const USER = 'user-1';
/** Another user at the same address: host-key decisions are never shared (D-29). */
const OTHER_USER = 'user-2';
const ADDRESS = { hostname: '127.0.0.1', port: SSHD_PORTS['no-tmux'] };

const store = new MemorySessionStore();
const hostKeys = new MemoryHostKeyStore();
let plane: DataPlane;
let url: string;
const clients: TestClient[] = [];

async function client(uid = USER): Promise<TestClient> {
  const c = await TestClient.connect(url, ORIGIN, signTicket(SECRET, { uid, asid: 'asid-1' }));
  clients.push(c);
  return c;
}

function createSession(id: string, userId = USER): SessionRuntime {
  const record = makeRecord({
    id,
    userId,
    target: {
      kind: 'ssh',
      ...ADDRESS,
      username: TEST_USER,
      credentialId: 'credential-1',
    },
    cols: 100,
    rows: 30,
  });
  store.add(record);
  plane.registry.create(record);
  return plane.registry.host(id)!;
}

/** Waits until the session produced no output for `quietMs`. */
async function quiet(runtime: SessionRuntime, quietMs = 300): Promise<void> {
  let seq = -1;
  let since = Date.now();
  await until(() => {
    if (runtime.seq !== seq) {
      seq = runtime.seq;
      since = Date.now();
    }
    return Date.now() - since >= quietMs;
  }, 15_000);
}

function screen(runtime: SessionRuntime): string {
  const buffer = runtime.emulator.terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)!.translateToString(true));
  return lines.join('\n');
}

function attach(c: TestClient, sessionId: string, cols: number, rows: number, channel = 1): void {
  c.send({ type: 'session.attach', channel, sessionId, viewport: { cols, rows } });
}

beforeAll(async () => {
  await requireSshd(['no-tmux']);
  hostKeys.trust({ userId: USER, ...ADDRESS }, HOST_KEY);
  plane = createDataPlane({
    publicOrigin: ORIGIN,
    ws: { host: '127.0.0.1', port: 0 },
    wsSecret: SECRET,
    installationId: 'install-t1',
    store,
    hostKeys,
    credentials: { get: async () => ({ kind: 'private_key', privateKey: USER_KEY }) },
    ownership: { sessionOwner: async (id) => store.records.get(id)?.userId ?? null },
    authSessions: { isValid: () => true },
    // The test sshd listens on 127.0.0.1, a local target the default policy refuses.
    targetPolicy: new TargetPolicy({ allowLocalTargets: true }),
    registry: { runtime: { resizeDebounceMs: 20 } },
  });
  const { address } = await plane.start();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await plane?.shutdown();
});

describe('raw PTY session over WebSocket (no-tmux)', () => {
  it('reattach restores vi exactly: buffers, cursor, alternate screen and tracked modes', async () => {
    const runtime = createSession('s-vi');
    await until(() => runtime.state === 'ready', 15_000);
    expect(runtime.protection).toBe('none');

    const first = await client();
    attach(first, 's-vi', 100, 30);
    await first.next((m) => m.type === 'session.attached');
    await quiet(runtime);
    // Modes SerializeAddon alone does not restore (SGR mouse, bar cursor, title), then vi.
    first.input(
      1,
      "printf '\\033[?1000h\\033[?1006h\\033[5 q\\033]2;tv-title\\007'; vi /etc/hosts\r",
    );
    await until(() => /localhost/.test(screen(runtime)), 10_000);
    first.input(1, 'Otermavox reattach line\x1b'); // busybox vi shows non-ASCII as dots
    await quiet(runtime);
    await first.close();

    const second = await client();
    attach(second, 's-vi', 100, 30);
    const terminal = second.terminal(1);
    await until(() => terminal.snapshots.length === 1, 10_000);
    const restored = await terminal.settle();
    await runtime.emulator.flush();
    const server = probe(runtime.emulator);
    expect(diff(server, probe(restored))).toEqual([]);
    expect(terminal.violations).toEqual([]);
    expect(server.tracker).toMatchObject({
      mouseEncoding: 'sgr',
      cursorShape: 'bar',
      title: 'tv-title',
    });
    expect(runtime.emulator.terminal.buffer.active.type).toBe('alternate');
    expect(restored.terminal.buffer.active.type).toBe('alternate');
    expect(screen(runtime)).toContain('termavox reattach line');

    await runtime.terminate();
  });

  it('two attachments: activating one resizes the session and both stay equal to the server', async () => {
    const runtime = createSession('s-multi');
    await until(() => runtime.state === 'ready', 15_000);
    const a = await client();
    const b = await client();
    attach(a, 's-multi', 100, 30); // first attachment: active
    await a.next((m) => m.type === 'session.attached');
    attach(b, 's-multi', 80, 24);
    await b.next((m) => m.type === 'session.attached');

    b.send({ type: 'terminal.activate', channel: 1 });
    await until(() => runtime.emulator.cols === 80 && runtime.emulator.rows === 24);
    b.input(1, 'echo from-b; seq 1 400\r');
    await until(() => /from-b/.test(screen(runtime)));
    // Input from a makes it active again: the resize lands in the middle of the output.
    a.input(1, 'seq 1000 1400; tput cols\r');
    await until(() => runtime.emulator.cols === 100);
    await quiet(runtime);

    await runtime.emulator.flush();
    const server = probe(runtime.emulator);
    for (const c of [a, b]) {
      const terminal = c.terminal(1);
      await until(() => terminal.lastSeq === runtime.seq);
      expect(diff(server, probe(await terminal.settle()))).toEqual([]);
      expect(terminal.violations).toEqual([]);
      expect(terminal.snapshots).toHaveLength(1);
      expect(terminal.resizes.map((r) => [r.cols, r.rows])).toEqual([
        [80, 24],
        [100, 30],
      ]);
    }
    expect(a.terminal(1).resizes.map((r) => r.active)).toEqual([false, true]);
    expect(b.terminal(1).resizes.map((r) => r.active)).toEqual([true, false]);
    expect(screen(runtime)).toMatch(/^100$/m); // the shell saw the new width
    await runtime.terminate();
  });

  it('unknown host key: hostkey.prompt → accept → reconnects and becomes ready', async () => {
    // USER trusts this address's key; OTHER_USER at the same address decides alone.
    const watcher = await client(OTHER_USER);
    const runtime = createSession('s-hostkey', OTHER_USER);
    const prompt = await watcher.next((m) => m.type === 'hostkey.prompt', 15_000);
    expect(prompt).toEqual({
      type: 'hostkey.prompt',
      sessionId: 's-hostkey',
      keyType: HOST_KEY.type,
      fingerprint: HOST_KEY.fingerprint,
      mismatch: false,
    });
    expect(runtime.state).toBe('awaiting_host_key');
    expect(hostKeys.pending.map((p) => p.target)).toEqual([
      { userId: OTHER_USER, ...ADDRESS, serverId: 'server-1' },
    ]);

    watcher.send({
      type: 'hostkey.decision',
      sessionId: 's-hostkey',
      fingerprint: HOST_KEY.fingerprint,
      accept: true,
    });
    await watcher.next(
      (m) => m.type === 'session.status' && m.sessionId === 's-hostkey' && m.status === 'connected',
      15_000,
    );
    expect(hostKeys.trustedAt({ userId: OTHER_USER, ...ADDRESS })?.get(HOST_KEY.type)).toEqual(
      HOST_KEY,
    );
    await runtime.terminate();
  });
});
