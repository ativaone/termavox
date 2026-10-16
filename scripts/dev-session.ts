/**
 * Dev-only CLI that drives a local session-manager end to end. Never shipped in images.
 *
 * From the repository root (test sshd containers: docker compose -f test/sshd/compose.yaml up -d --build):
 *
 *   node scripts/dev-session.ts init [--force]
 *       Creates ./data/dev (gitignored) with generated secrets (master_key, internal_token,
 *       ws_secret; mode 0600) and daemon.env. --force regenerates them and deletes the dev DB.
 *   node --env-file=data/dev/daemon.env apps/session-manager/src/main.ts
 *       Runs the daemon (another terminal). WS on 127.0.0.1:3001, internal API on 127.0.0.1:3002.
 *   node scripts/dev-session.ts seed [--target no-tmux|tmux-3.2a|tmux-3.4|tmux-edge] [--auth key|password]
 *       Needs the daemon running. Inserts a dev admin user, a host and a profile (web-owned
 *       tables, directly in the DB), creates the credential through the internal API (the test
 *       key from test/sshd/keys or the test password) and pre-trusts the host key from
 *       test/sshd/keys/known_hosts through `trust-key`. Ids are saved to data/dev/seed.json.
 *   node scripts/dev-session.ts create [--profile <id>] [--label <text>]
 *       Creates a session through the internal API (default: the last seeded profile).
 *   node scripts/dev-session.ts attach [<sessionId>]
 *       Inserts a dev auth_session row, mints a WS ticket and attaches in this terminal (raw
 *       mode). Ctrl-] detaches. Default: the last created session.
 *   node scripts/dev-session.ts list
 *   node scripts/dev-session.ts terminate [<sessionId>]
 *
 * Secret contents are never printed; only their file paths.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  type DaemonConfig,
  loadDaemonConfig,
  readSecretFile,
} from '../apps/session-manager/src/config/config.ts';
import { parsePublicKeyLine } from '../apps/session-manager/src/transport/ssh/host-key.ts';
import { openDb } from '../packages/db/src/index.ts';
import {
  decodeFrame,
  encodeFrame,
  FrameFlag,
  FrameType,
  INTERNAL_API_PREFIX,
  signTicket,
} from '../packages/protocol/src/index.ts';
import { randomToken, uuidv7 } from '../packages/shared/src/index.ts';

const ROOT = join(import.meta.dirname, '..');
const DEV_DIR = join(ROOT, 'data', 'dev');
const ENV_FILE = join(DEV_DIR, 'daemon.env');
const SEED_FILE = join(DEV_DIR, 'seed.json');
const KEYS_DIR = join(ROOT, 'test', 'sshd', 'keys');
const TARGETS = { 'no-tmux': 2201, 'tmux-3.2a': 2202, 'tmux-3.4': 2203, 'tmux-edge': 2204 };
type Target = keyof typeof TARGETS;
const TEST_USER = 'td';
const TEST_PASSWORD = 'termdock-test-password';
const DETACH_KEY = 0x1d; // Ctrl-]

interface Seed {
  userId: string;
  hostId?: string;
  profileId?: string;
  credentialId?: string;
  sessionId?: string;
}

function fail(message: string): never {
  console.error(`dev-session: ${message}`);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readSeed(): Seed | null {
  return existsSync(SEED_FILE) ? (JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Seed) : null;
}

function writeSeed(seed: Seed): void {
  writeFileSync(SEED_FILE, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
}

function devConfig(): DaemonConfig {
  if (!existsSync(ENV_FILE))
    fail('data/dev is not initialized; run: node scripts/dev-session.ts init');
  process.loadEnvFile(ENV_FILE);
  return loadDaemonConfig();
}

/** Calls the internal API with the dev bearer token. */
async function api(
  config: DaemonConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = new TextDecoder().decode(await readSecretFile(config.internalTokenFile));
  const url = `http://${config.internalHost}:${config.internalPort}${INTERNAL_API_PREFIX}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    fail(
      `daemon not reachable at ${url}; start it with: node --env-file=data/dev/daemon.env apps/session-manager/src/main.ts`,
    );
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) fail(`${method} ${path} → ${res.status} ${text}`);
  return json;
}

// ── init ────────────────────────────────────────────────────────────────────

function init(args: string[]): void {
  const force = args.includes('--force');
  const files = {
    master_key: () => randomBytes(32).toString('base64'),
    internal_token: () => randomBytes(32).toString('base64url'),
    ws_secret: () => randomBytes(32).toString('base64url'),
  };
  if (existsSync(join(DEV_DIR, 'master_key')) && !force) {
    fail(
      'data/dev is already initialized (--force regenerates every secret and deletes the dev DB)',
    );
  }
  mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });
  if (force) {
    for (const name of ['app.db', 'app.db-wal', 'app.db-shm', 'seed.json']) {
      rmSync(join(DEV_DIR, name), { force: true });
    }
  }
  for (const [name, generate] of Object.entries(files)) {
    writeFileSync(join(DEV_DIR, name), `${generate()}\n`, { mode: 0o600 });
  }
  const env = {
    TERMDOCK_PUBLIC_URL: 'http://localhost:3000',
    TERMDOCK_DATA_DIR: DEV_DIR,
    TERMDOCK_MASTER_KEY_FILE: join(DEV_DIR, 'master_key'),
    TERMDOCK_INTERNAL_TOKEN_FILE: join(DEV_DIR, 'internal_token'),
    TERMDOCK_WS_SECRET_FILE: join(DEV_DIR, 'ws_secret'),
    TERMDOCK_WS_HOST: '127.0.0.1',
    TERMDOCK_WS_PORT: '3001',
    TERMDOCK_INTERNAL_HOST: '127.0.0.1',
    TERMDOCK_INTERNAL_PORT: '3002',
    TERMDOCK_LOG_LEVEL: 'info',
    // The test sshd containers listen on 127.0.0.1, a local target refused by default.
    TERMDOCK_SSH_ALLOW_LOCAL_TARGETS: 'true',
  };
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(
    ENV_FILE,
    `# Generated by scripts/dev-session.ts (dev only)\n${lines.join('\n')}\n`,
    {
      mode: 0o600,
    },
  );
  console.log('dev data dir initialized:');
  for (const name of [...Object.keys(files), 'daemon.env']) console.log(`  ${join(DEV_DIR, name)}`);
  console.log('run the daemon with:');
  console.log('  node --env-file=data/dev/daemon.env apps/session-manager/src/main.ts');
}

// ── seed ────────────────────────────────────────────────────────────────────

function knownHostKey(port: number): { keyType: string; fingerprint: string } {
  const line = readFileSync(join(KEYS_DIR, 'known_hosts'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`[127.0.0.1]:${port} `));
  if (!line) fail(`no known_hosts entry for [127.0.0.1]:${port}`);
  // `[host]:port type base64`: drop the host field before parsing the key.
  const key = parsePublicKeyLine(line.split(/\s+/).slice(1).join(' '));
  return { keyType: key.type, fingerprint: key.fingerprint };
}

async function seed(args: string[]): Promise<void> {
  const target = (option(args, '--target') ?? 'no-tmux') as Target;
  const auth = option(args, '--auth') ?? 'key';
  const port = TARGETS[target];
  if (!port) fail(`unknown --target ${target} (${Object.keys(TARGETS).join('|')})`);
  if (auth !== 'key' && auth !== 'password') fail('--auth must be key or password');
  const config = devConfig();
  await api(config, 'GET', '/health');

  const db = openDb(config.dbFile);
  const sqlite = db.$client;
  const now = Date.now();
  try {
    let user = sqlite.prepare('SELECT id FROM user WHERE username = ?').get('dev') as
      | { id: string }
      | undefined;
    if (!user) {
      user = { id: uuidv7() };
      sqlite
        .prepare(
          `INSERT INTO user (id, name, email, username, display_username, role, created_at, updated_at)
           VALUES (?, 'Dev', 'dev@termdock.local', 'dev', 'dev', 'admin', ?, ?)`,
        )
        .run(user.id, now, now);
    }
    const userId = user.id;
    const credential = (await api(config, 'POST', '/credentials', {
      actingUserId: userId,
      name: `dev ${target} (${auth})`,
      ...(auth === 'key'
        ? { kind: 'private_key', privateKey: readFileSync(join(KEYS_DIR, 'id_ed25519'), 'utf8') }
        : { kind: 'password', password: TEST_PASSWORD }),
    })) as { credentialId: string };

    const hostId = uuidv7();
    sqlite
      .prepare(
        `INSERT INTO hosts (id, user_id, name, kind, hostname, port, created_at, updated_at)
         VALUES (?, ?, ?, 'ssh', '127.0.0.1', ?, ?, ?)`,
      )
      .run(hostId, userId, `dev ${target}`, port, now, now);
    await api(config, 'POST', `/hosts/${hostId}/trust-key`, {
      actingUserId: userId,
      ...knownHostKey(port),
    });

    const profileId = uuidv7();
    sqlite
      .prepare(
        `INSERT INTO connection_profiles (id, user_id, host_id, credential_id, name, username, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profileId,
        userId,
        hostId,
        credential.credentialId,
        `dev ${target} (${auth})`,
        TEST_USER,
        now,
        now,
      );

    const seeded: Seed = { userId, hostId, profileId, credentialId: credential.credentialId };
    writeSeed(seeded);
    console.log(JSON.stringify(seeded, null, 2));
  } finally {
    sqlite.close();
  }
}

// ── sessions ────────────────────────────────────────────────────────────────

function requireSeed(): Seed {
  return readSeed() ?? fail('nothing seeded yet; run: node scripts/dev-session.ts seed');
}

async function create(args: string[]): Promise<void> {
  const config = devConfig();
  const seeded = requireSeed();
  const profileId = option(args, '--profile') ?? seeded.profileId;
  if (!profileId) fail('no profile; pass --profile <id>');
  const label = option(args, '--label');
  const { sessionId } = (await api(config, 'POST', '/sessions', {
    actingUserId: seeded.userId,
    profileId,
    ...(label ? { label } : {}),
    viewport: {
      cols: Math.min(500, Math.max(20, process.stdout.columns ?? 120)),
      rows: Math.min(200, Math.max(5, process.stdout.rows ?? 32)),
    },
  })) as { sessionId: string };
  writeSeed({ ...seeded, sessionId });
  console.log(sessionId);
}

async function list(): Promise<void> {
  const config = devConfig();
  const seeded = requireSeed();
  const result = await api(
    config,
    'GET',
    `/sessions?actingUserId=${encodeURIComponent(seeded.userId)}`,
  );
  console.log(JSON.stringify(result, null, 2));
}

async function terminate(args: string[]): Promise<void> {
  const config = devConfig();
  const seeded = requireSeed();
  const sessionId = args[0] ?? seeded.sessionId ?? fail('no session id');
  await api(config, 'POST', `/sessions/${sessionId}/terminate`, { actingUserId: seeded.userId });
  console.log(`terminated ${sessionId}`);
}

// ── attach ──────────────────────────────────────────────────────────────────

async function attach(args: string[]): Promise<void> {
  const config = devConfig();
  const seeded = requireSeed();
  const sessionId = args[0] ?? seeded.sessionId ?? fail('no session id; run create first');
  if (!process.stdin.isTTY) fail('attach needs a TTY');

  // A dev auth_session row: the daemon re-validates it on hello and every minute.
  const db = openDb(config.dbFile);
  const sqlite = db.$client;
  const authSessionId = uuidv7();
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO auth_session (id, token, user_id, expires_at, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'dev-session', ?, ?)`,
    )
    .run(authSessionId, randomToken(32), seeded.userId, now + 3_600_000, now, now);
  const ticket = signTicket(await readSecretFile(config.wsSecretFile), {
    uid: seeded.userId,
    asid: authSessionId,
  });

  const channel = 1;
  const viewport = (): { cols: number; rows: number } => ({
    cols: Math.min(1000, Math.max(1, process.stdout.columns ?? 80)),
    rows: Math.min(1000, Math.max(1, process.stdout.rows ?? 24)),
  });
  const ws = new WebSocket(`ws://${config.wsHost}:${config.wsPort}/ws`, {
    headers: { origin: config.publicOrigin },
  });
  ws.binaryType = 'arraybuffer';
  const send = (message: unknown): void => ws.send(JSON.stringify(message));
  let restored = false;
  // OUTPUT frames are applied only after a SNAPSHOT and in seq order (plan §5.4).
  let lastSeq = -1n;
  const finish = (reason: string): void => {
    if (restored) return;
    restored = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    sqlite.prepare('DELETE FROM auth_session WHERE id = ?').run(authSessionId);
    sqlite.close();
    process.stderr.write(`\r\n[dev-session] ${reason}\r\n`);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    process.exit(0);
  };

  ws.addEventListener('open', () => send({ type: 'hello', protocol: 1, ticket }));
  ws.addEventListener('close', (event) =>
    finish(`connection closed (${event.code} ${event.reason})`),
  );
  ws.addEventListener('error', () => finish('connection error'));
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data) as { type: string; [key: string]: unknown };
      if (message.type === 'hello.ok') {
        send({ type: 'session.attach', channel, sessionId, viewport: viewport() });
        process.stdin.setRawMode(true);
        process.stdin.resume();
      } else if (message.type === 'session.status' && message.sessionId === sessionId) {
        if (message.status === 'ended') finish(`session ended (${String(message.detail ?? '')})`);
      } else if (message.type === 'hostkey.prompt' || message.type === 'auth.prompt') {
        process.stderr.write(`\r\n[dev-session] ${message.type} (not handled by this client)\r\n`);
      } else if (message.type === 'error') {
        finish(`error ${String(message.code)}: ${String(message.message)}`);
      }
      return;
    }
    const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
    if (frame.channel !== channel) return;
    if (frame.type === FrameType.Output) {
      if (lastSeq < 0n || frame.seq <= lastSeq) return;
      lastSeq = frame.seq;
      process.stdout.write(frame.payload);
    } else if (frame.type === FrameType.Snapshot) {
      lastSeq = frame.seq;
      const payload = frame.flags & FrameFlag.Gzip ? gunzipSync(frame.payload) : frame.payload;
      process.stdout.write('\x1b[H\x1b[2J\x1b[3J');
      process.stdout.write(payload);
    }
  });

  process.stdin.on('data', (data: Buffer) => {
    if (data.includes(DETACH_KEY)) {
      finish('detached');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeFrame({ type: FrameType.Input, flags: 0, channel, seq: 0n, payload: data }));
  });
  process.stdout.on('resize', () => {
    if (ws.readyState === WebSocket.OPEN)
      send({ type: 'terminal.viewport', channel, ...viewport() });
  });
}

// ── main ────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'init':
    init(rest);
    break;
  case 'seed':
    await seed(rest);
    break;
  case 'create':
    await create(rest);
    break;
  case 'attach':
    await attach(rest);
    break;
  case 'list':
    await list();
    break;
  case 'terminate':
    await terminate(rest);
    break;
  default:
    console.error(
      'usage: node scripts/dev-session.ts <init|seed|create|attach|list|terminate> (see the header of this file)',
    );
    process.exit(2);
}
