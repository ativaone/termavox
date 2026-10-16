// T1: the real daemon wiring (SQLite stores, vault, internal API, WS) booted in-process against
// the no-tmux sshd, restarted on the same DB.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signTicket } from '@termdock/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonConfig } from '../../src/config/config.ts';
import type { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';
import { type Daemon, startDaemon } from '../../src/main.ts';
import { until } from '../runtime/fakes.ts';
import { HOST_KEY, requireSshd, SSHD_PORTS, TEST_USER, USER_KEY } from '../ssh/sshd.ts';
import { insertAuthSession, insertHost, insertProfile, insertUser } from '../store/fixture.ts';
import { TestClient } from '../ws/client.ts';

const ORIGIN = 'http://localhost:3000';
const TOKEN = randomBytes(32).toString('base64url');
const WS_SECRET = randomBytes(32).toString('base64url');

let dir: string;
let config: DaemonConfig;
const daemons: Daemon[] = [];
const clients: TestClient[] = [];

async function boot(): Promise<Daemon> {
  const daemon = await startDaemon(config);
  daemons.push(daemon);
  return daemon;
}

async function api(daemon: Daemon, method: string, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${daemon.internalAddress.port}/internal/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function attach(daemon: Daemon, userId: string, asid: string, sessionId: string) {
  const ticket = signTicket(new TextEncoder().encode(WS_SECRET), { uid: userId, asid });
  const client = await TestClient.connect(
    `ws://127.0.0.1:${daemon.wsAddress.port}/ws`,
    ORIGIN,
    ticket,
  );
  clients.push(client);
  client.send({ type: 'session.attach', channel: 1, sessionId, viewport: { cols: 100, rows: 30 } });
  await client.next((m) => m.type === 'session.attached');
  return client;
}

function screen(emulator: HeadlessEmulator): string {
  const buffer = emulator.terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)!.translateToString(true));
  return lines.join('\n');
}

/** Waits until the client's restored terminal shows `pattern`. */
async function shows(client: TestClient, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
  const terminal = client.terminal(1);
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (terminal.emulator) {
      text = screen(await terminal.settle());
      if (pattern.test(text)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`terminal never showed ${pattern}; screen:\n${text}`);
}

beforeAll(async () => {
  await requireSshd(['no-tmux']);
  dir = mkdtempSync(join(tmpdir(), 'termdock-daemon-'));
  const secret = (name: string, value: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
    return path;
  };
  config = {
    publicUrl: ORIGIN,
    publicOrigin: ORIGIN,
    wsHost: '127.0.0.1',
    wsPort: 0,
    wsSecretFile: secret('ws_secret', WS_SECRET),
    logLevel: 'silent',
    dataDir: dir,
    masterKeyFile: secret('master_key', randomBytes(32).toString('base64')),
    internalTokenFile: secret('internal_token', TOKEN),
    internalHost: '127.0.0.1',
    internalPort: 0,
    enableLocalShell: false,
    dbFile: join(dir, 'app.db'),
  };
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  for (const daemon of daemons) await daemon.shutdown().catch(() => {});
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('daemon (SQLite + vault + internal API + WS) against no-tmux', () => {
  it('creates, attaches, survives a daemon restart as a new shell, and terminates', async () => {
    // ── first boot: seed through the stores, create over the internal API ──
    const first = await boot();
    const { db } = first;
    const userId = insertUser(db);
    const hostId = insertHost(db, userId, { name: 'no-tmux', port: SSHD_PORTS['no-tmux'] });
    const { credentialId } = await first.credentials.create({
      actingUserId: userId,
      kind: 'private_key',
      name: 'test key',
      privateKey: USER_KEY,
    });
    // "Fetch & verify": the unknown key is recorded as pending, then trusted by fingerprint.
    const fetched = await api(first, 'POST', `/hosts/${hostId}/test`, { actingUserId: userId });
    expect(fetched).toEqual({
      status: 200,
      json: {
        reachable: true,
        error: null,
        hostKey: { type: HOST_KEY.type, fingerprint: HOST_KEY.fingerprint, trusted: false },
        probe: null,
      },
    });
    expect((await first.hostKeys.list(hostId)).map((k) => k.status)).toEqual(['pending']);
    const trustKey = { actingUserId: userId, keyType: HOST_KEY.type };
    expect(
      (
        await api(first, 'POST', `/hosts/${hostId}/trust-key`, {
          ...trustKey,
          fingerprint: HOST_KEY.fingerprint,
        })
      ).status,
    ).toBe(204);
    const profileId = insertProfile(db, userId, hostId, credentialId, {
      username: TEST_USER,
      autoReopen: true,
    });
    // With a profile and a trusted key the test authenticates and runs the capability probe.
    const probed = await api(first, 'POST', `/hosts/${hostId}/test`, {
      actingUserId: userId,
      profileId,
    });
    expect(probed.json).toMatchObject({
      reachable: true,
      error: null,
      hostKey: { trusted: true },
      probe: { shell: '/bin/bash' }, // no-tmux image: no tmux_path key
    });
    const asid = insertAuthSession(db, userId, Date.now() + 3_600_000);

    const created = await api(first, 'POST', '/sessions', {
      actingUserId: userId,
      profileId,
      viewport: { cols: 100, rows: 30 },
    });
    expect(created.status).toBe(201);
    const sessionId = created.json?.sessionId as string;
    await until(() => first.plane.registry.host(sessionId)?.state === 'ready', 15_000);

    const client = await attach(first, userId, asid, sessionId);
    await shows(client, /\$ ?$/m);
    client.input(1, 'echo first-$((40+2))\r');
    await shows(client, /^first-42$/m);
    await client.close();

    // ── restart on the same DB ──
    await first.shutdown();
    const second = await boot();
    const row = second.db.$client
      .prepare(
        'SELECT desired_state, state, protection_effective, last_ready_at FROM sessions WHERE id = ?',
      )
      .get(sessionId) as Record<string, unknown>;
    expect(row).toMatchObject({
      desired_state: 'running',
      state: 'ready',
      protection_effective: 'none',
    });
    expect(row.last_ready_at).toEqual(expect.any(Number));
    await second.restored;
    await until(() => second.plane.registry.host(sessionId)?.state === 'ready', 15_000);

    // raw protection + auto_reopen: the screen was in RAM; a new shell starts after a banner.
    const again = await attach(second, userId, asid, sessionId);
    const restored = await shows(again, /Termdock restarted/);
    expect(restored).not.toContain('first-42');
    again.input(1, 'echo second-$((1+1))\r');
    await shows(again, /^second-2$/m);
    await second.writer.flush();
    const events = (
      second.db.$client
        .prepare('SELECT type FROM session_events WHERE session_id = ? ORDER BY rowid')
        .all(sessionId) as Array<{ type: string }>
    ).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['created', 'restore_started', 'restored']));

    // ── terminate over the internal API ──
    const terminated = await api(second, 'POST', `/sessions/${sessionId}/terminate`, {
      actingUserId: userId,
    });
    expect(terminated.status).toBe(204);
    await again.next(
      (m) => m.type === 'session.status' && m.sessionId === sessionId && m.status === 'ended',
    );
    await second.writer.flush();
    expect(
      second.db.$client
        .prepare('SELECT desired_state, state, end_reason FROM sessions WHERE id = ?')
        .get(sessionId),
    ).toEqual({ desired_state: 'terminated', state: 'ended', end_reason: 'user_terminated' });
  });
});
