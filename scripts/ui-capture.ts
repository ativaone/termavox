// Building blocks for UI capture sessions: the review screenshots of a delivery and the images in
// docs/screenshots. Everything runs on private ports, isolated from any real install:
//   - the test sshd containers (test/sshd/compose.yaml, compose project termavox-sshd, 2201-2204);
//   - session-manager with a throwaway data dir under data/ (gitignored);
//   - the web app's production build with `next start` (`next dev` runs out of memory beside
//     Chromium on small machines), its WebSocket URL inlined at build time;
//   - a local headless Chromium driven over CDP (scripts/cdp.ts).
// A capture script imports this module, adds its own scenes and is kept outside the repository:
//
//   import { FRAMES, runCapture } from '<repo>/scripts/ui-capture.ts';
//   await runCapture({ name: 'review', out: '/tmp/shots' }, async (c) => {
//     await c.setupAdmin();
//     const servers = await c.seedServers([{ name: 'api-prod', port: 2203, trust: true }]);
//     ...
//     await c.shot('workspace', FRAMES.desktop1x);
//   });
//
// How to write and run one (memory cap, scene recipes, pitfalls): .claude/skills/ui-capture.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type CdpPage, type Chromium, findChromium, launchChromium, sleep } from './cdp.ts';

const ROOT = join(import.meta.dirname, '..');
const KEYS = join(ROOT, 'test', 'sshd', 'keys');
const SSHD_COMPOSE = join(ROOT, 'test', 'sshd', 'compose.yaml');
const SSHD_PORTS = [2201, 2202, 2203, 2204];
const INTERNAL_API = '/internal/v1';

export interface Frame {
  name: string;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
}

/** The release checklist's frames: always include a 1x desktop one (it shows hinting defects). */
export const FRAMES = {
  desktop1x: { name: 'desktop-1x', width: 1440, height: 900, scale: 1, mobile: false },
  desktop2x: { name: 'desktop-2x', width: 1440, height: 900, scale: 2, mobile: false },
  phone: { name: 'phone', width: 390, height: 844, scale: 2, mobile: true },
} satisfies Record<string, Frame>;

export interface CaptureOptions {
  /** Names the data dir (`data/<name>-dev`) and the Chromium profile in it. */
  name: string;
  /** Directory for the screenshots and the run's reports (console.json, measurements.json). */
  out: string;
  locale?: 'en' | 'pt-BR';
  /** Default 3200 / 3201 / 3202, clear of a dev stack on 3000-3002. */
  ports?: { web: number; ws: number; internal: number };
  /** Start the test sshd containers for the run and stop them after (default true). */
  sshd?: boolean;
  /** Run `next build` first with this run's WebSocket URL inlined (default true). */
  build?: boolean;
}

export interface ServerSeed {
  name: string;
  /** A test sshd port (2201 no tmux, 2202 tmux 3.2a, 2203 tmux 3.4, 2204 newest) or any port. */
  port: number;
  /** Pre-trust the host key from test/sshd/keys/known_hosts, so sessions connect at once. */
  trust?: boolean;
  /** Default 127.0.0.1; `<name>.localhost` also resolves to loopback and reads better on screen. */
  hostname?: string;
  username?: string;
  /** False: no stored credential (the server asks in the terminal). */
  credential?: false;
  env?: Record<string, string>;
  keepaliveSeconds?: number;
}

export const DEFAULT_ADMIN = {
  username: 'maria',
  email: 'maria@example.test',
  password: 'Capture-owner-2026!',
};

// ── page-side expression helpers (strings evaluated with the scripts/cdp.ts prelude) ─────────
export const js = (value: unknown) => JSON.stringify(value);
/** Some visible text in the page contains `label`. */
export const shown = (label: string) =>
  `$$('main *, aside *, dialog *').some((n) => visible(n) && text(n).includes(${js(label)}))`;
/** The visible button whose text is exactly `label`. */
export const buttonText = (label: string) =>
  `$$('button').find((b) => visible(b) && text(b) === ${js(label)})`;
/** A session's row in the session list. */
export const rowOf = (sessionId: string) =>
  `($(${js(`a[href="/workspace?s=${encodeURIComponent(sessionId)}"]`)})?.closest('[data-status]') ?? null)`;
/** The actions button of a session's row. */
export const menuOf = (sessionId: string) =>
  `${rowOf(sessionId)}?.querySelector('button[aria-haspopup=menu]')`;
/** An item of the open menu, by the start of its text. */
export const menuItem = (label: string) =>
  `$$('[role=menu] button, [role=menu] [role=menuitem]').find((b) => visible(b) && text(b).startsWith(${js(label)}))`;
/** Fills `{key}` placeholders of a message. */
export const fmt = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);

/** A time-ordered id (UUIDv7 layout), like the app's own ids. */
function uuidv7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The test sshd host key on `port`, as the trust-key route takes it. */
function knownHostKey(port: number): { keyType: string; fingerprint: string } {
  const line = readFileSync(join(KEYS, 'known_hosts'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`[127.0.0.1]:${port} `));
  const [, keyType, b64] = line?.split(/\s+/) ?? [];
  if (!keyType || !b64) throw new Error(`no known_hosts entry for port ${port}`);
  const digest = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64');
  return { keyType, fingerprint: `SHA256:${digest.replace(/=+$/, '')}` };
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const log = (message: string) =>
  console.log(`[capture ${new Date().toISOString().slice(11, 19)}] ${message}`);

export class Capture {
  readonly base: string;
  readonly out: string;
  readonly dataDir: string;
  readonly #options: Required<Omit<CaptureOptions, 'ports'>> & {
    ports: NonNullable<CaptureOptions['ports']>;
  };
  readonly #children = new Set<ChildProcess>();
  readonly #console: Array<Record<string, unknown>> = [];
  readonly #measurements: Record<string, unknown> = {};
  readonly #failures: string[] = [];
  readonly #written: string[] = [];
  #browser: Chromium | null = null;
  #sshdUp = false;
  #stopped = false;
  #setupToken: string | null = null;
  #userId: string | null = null;

  private constructor(options: CaptureOptions) {
    this.#options = {
      locale: 'en',
      sshd: true,
      build: true,
      ...options,
      ports: options.ports ?? { web: 3200, ws: 3201, internal: 3202 },
    };
    this.base = `http://localhost:${this.#options.ports.web}`;
    this.out = options.out;
    this.dataDir = join(ROOT, 'data', `${options.name}-dev`);
  }

  /** Builds (unless disabled), starts the stack and the browser, and opens a blank page. */
  static async start(options: CaptureOptions): Promise<Capture> {
    const capture = new Capture(options);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => {
        void capture.stop().finally(() => process.exit(130));
      });
    }
    try {
      await capture.#start();
    } catch (err) {
      await capture.stop();
      throw err;
    }
    return capture;
  }

  get page(): CdpPage {
    if (!this.#browser) throw new Error('the browser is not running');
    return this.#browser.page;
  }

  /** The admin's user id, once setupAdmin() has run. */
  get userId(): string {
    if (!this.#userId) throw new Error('no admin yet: call setupAdmin() first');
    return this.#userId;
  }

  async #start(): Promise<void> {
    const { ports, sshd, build, locale } = this.#options;
    const busy: number[] = [];
    for (const port of [ports.web, ports.ws, ports.internal]) {
      if (await portOpen(port)) busy.push(port);
    }
    if (busy.length) throw new Error(`ports already in use: ${busy.join(', ')}`);
    mkdirSync(this.out, { recursive: true });
    const { daemonEnv, webEnv } = this.#prepareData();

    if (build) {
      log('next build (production build, WebSocket URL inlined)');
      const result = spawnSync(
        join(ROOT, 'apps', 'web', 'node_modules', '.bin', 'next'),
        ['build'],
        {
          cwd: join(ROOT, 'apps', 'web'),
          env: webEnv,
          stdio: 'inherit',
        },
      );
      if (result.status !== 0) {
        throw new Error(`next build failed (${result.signal ?? result.status})`);
      }
    }

    if (sshd) {
      log('starting the test sshd containers');
      if (this.compose(['up', '-d']) !== 0) throw new Error('docker compose up failed');
      this.#sshdUp = true;
      await this.#until(
        async () => (await Promise.all(SSHD_PORTS.map(portOpen))).every(Boolean),
        'the sshd containers',
      );
      await sleep(1_500);
    }

    this.#spawn('daemon', 'node', ['apps/session-manager/src/main.ts'], daemonEnv, ROOT);
    await this.#until(async () => {
      try {
        await this.api('GET', '/health');
        return true;
      } catch {
        return false;
      }
    }, 'the daemon');
    const next = join(ROOT, 'apps', 'web', 'node_modules', '.bin', 'next');
    this.#spawn(
      'web',
      next,
      ['start', '-p', String(ports.web), '-H', '127.0.0.1'],
      webEnv,
      join(ROOT, 'apps', 'web'),
      (line) => {
        const match = /setup token: (\S+)/.exec(line);
        if (match?.[1]) this.#setupToken = match[1];
      },
    );
    await this.#until(async () => {
      try {
        return (await fetch(`${this.base}/api/health`, { cache: 'no-store' })).ok;
      } catch {
        return false;
      }
    }, 'the web app');
    log(`daemon and web up at ${this.base}`);

    this.#browser = await launchChromium({
      executable: findChromium(),
      userDataDir: join(this.dataDir, 'chrome-profile'),
      args: [
        '--window-size=1440,900',
        '--hide-scrollbars',
        `--lang=${locale}`,
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--renderer-process-limit=2',
      ],
    });
    const page = this.#browser.page;
    await page.send('Log.enable');
    page.on('Runtime.exceptionThrown', (params) => {
      const p = params as {
        exceptionDetails: { text: string; exception?: { description?: string } };
      };
      this.#console.push({
        kind: 'exception',
        text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text,
      });
    });
    page.on('Log.entryAdded', (params) => {
      const { entry } = params as { entry: Record<string, unknown> };
      this.#console.push({ kind: 'log', ...entry });
    });
    await page.send('Network.setCookie', { name: 'NEXT_LOCALE', value: locale, url: this.base });
    await this.setFrame(FRAMES.desktop1x);
  }

  #prepareData(): { daemonEnv: NodeJS.ProcessEnv; webEnv: NodeJS.ProcessEnv } {
    const { ports } = this.#options;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    // A fresh database per run; the secrets are kept.
    for (const file of ['app.db', 'app.db-wal', 'app.db-shm']) {
      rmSync(join(this.dataDir, file), { force: true });
    }
    const secret = (name: string, value: () => string) => {
      const path = join(this.dataDir, name);
      if (!existsSync(path)) writeFileSync(path, `${value()}\n`, { mode: 0o600 });
      return path;
    };
    const internalToken = secret('internal_token', () => randomBytes(32).toString('base64url'));
    const wsSecret = secret('ws_secret', () => randomBytes(32).toString('base64url'));
    const common = { TERMAVOX_PUBLIC_URL: this.base, TERMAVOX_DATA_DIR: this.dataDir };
    return {
      daemonEnv: {
        ...process.env,
        ...common,
        TERMAVOX_MASTER_KEY_FILE: secret('master_key', () => randomBytes(32).toString('base64')),
        TERMAVOX_INTERNAL_TOKEN_FILE: internalToken,
        TERMAVOX_WS_SECRET_FILE: wsSecret,
        TERMAVOX_WS_HOST: '127.0.0.1',
        TERMAVOX_WS_PORT: String(ports.ws),
        TERMAVOX_INTERNAL_HOST: '127.0.0.1',
        TERMAVOX_INTERNAL_PORT: String(ports.internal),
        TERMAVOX_LOG_LEVEL: 'warn',
        // The test sshd containers listen on loopback.
        TERMAVOX_SSH_ALLOW_LOCAL_TARGETS: 'true',
      },
      webEnv: {
        ...process.env,
        ...common,
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET_FILE: secret('better_auth_secret', () =>
          randomBytes(32).toString('base64url'),
        ),
        TERMAVOX_WS_SECRET_FILE: wsSecret,
        TERMAVOX_INTERNAL_URL: `http://127.0.0.1:${ports.internal}`,
        TERMAVOX_INTERNAL_TOKEN_FILE: internalToken,
        NEXT_PUBLIC_TERMAVOX_WS_URL: `ws://127.0.0.1:${ports.ws}/ws`,
        NEXT_TELEMETRY_DISABLED: '1',
      },
    };
  }

  #spawn(
    name: string,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    onLine?: (line: string) => void,
  ): void {
    // Its own process group, so stop() also ends what it spawns.
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    this.#children.add(child);
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        console.log(`  [${name}] ${line}`);
        onLine?.(line);
      }
    };
    child.stdout?.on('data', relay);
    child.stderr?.on('data', relay);
    child.once('exit', (code, signal) => log(`${name} exited (${signal ?? code})`));
  }

  async #until(probe: () => Promise<boolean>, label: string, timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /** docker compose on the test sshd stack (e.g. `['stop', 'tmux-3.2a']` to drop a server). */
  compose(args: string[]): number {
    const result = spawnSync('docker', ['compose', '-f', SSHD_COMPOSE, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of `${result.stdout}${result.stderr}`.split('\n')) {
      if (line.trim()) console.log(`  [sshd] ${line}`);
    }
    return result.status ?? 1;
  }

  /** A call to the daemon's internal API, authenticated like web. */
  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = readFileSync(join(this.dataDir, 'internal_token'), 'utf8').trim();
    const res = await fetch(
      `http://127.0.0.1:${this.#options.ports.internal}${INTERNAL_API}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Runs `fn` on the run's database (web owns the servers table, so seeds write it here). */
  db<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(this.dataDir, 'app.db'));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** Creates the first admin through /setup (token from web's log); lands in the workspace. */
  async setupAdmin(admin = DEFAULT_ADMIN): Promise<string> {
    const page = this.page;
    await page.navigate(`${this.base}/setup`, 180_000);
    await page.waitHydrated(`$('input[name=token]')?.closest('form')`, 'the setup form', 180_000);
    await this.#until(
      async () => this.#setupToken !== null,
      'the setup token in the web log',
      30_000,
    );
    await page.fill(`$('input[name=token]')`, this.#setupToken!, 'setup token');
    await page.fill(`$('input[name=username]')`, admin.username, 'username');
    await page.fill(`$('input[name=email]')`, admin.email, 'email');
    await page.fill(`$('input[name=password]')`, admin.password, 'password');
    await page.fill(`$('input[name=confirm]')`, admin.password, 'confirmation');
    await page.click(
      `$('input[name=token]').closest('form').querySelector('button[type=submit]')`,
      'create the administrator',
    );
    await page.waitFor(`location.pathname === '/workspace'`, 'the workspace after setup', 180_000);
    const row = this.db(
      (db) =>
        db.prepare('SELECT id FROM user WHERE username = ?').get(admin.username) as
          | { id: string }
          | undefined,
    );
    if (!row) throw new Error('no admin user after setup');
    this.#userId = row.id;
    log('admin created');
    return row.id;
  }

  /**
   * Adds servers for the admin, sharing one credential made from the test key, and pre-trusts
   * the host keys asked for. Returns the server ids by name.
   */
  async seedServers(seeds: ServerSeed[]): Promise<Record<string, string>> {
    const userId = this.userId;
    const { credentialId } = await this.api<{ credentialId: string }>('POST', '/credentials', {
      actingUserId: userId,
      name: 'deploy key',
      kind: 'private_key',
      privateKey: readFileSync(join(KEYS, 'id_ed25519'), 'utf8'),
    });
    const ids: Record<string, string> = {};
    const now = Date.now();
    this.db((db) => {
      const insert = db.prepare(
        `INSERT INTO servers (id, user_id, name, kind, hostname, port, username, credential_id,
           env_json, keepalive_interval_s, created_at, updated_at)
         VALUES (?, ?, ?, 'ssh', ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const seed of seeds) {
        const id = uuidv7();
        ids[seed.name] = id;
        insert.run(
          id,
          userId,
          seed.name,
          seed.hostname ?? '127.0.0.1',
          seed.port,
          seed.username ?? 'tv',
          seed.credential === false ? null : credentialId,
          JSON.stringify(seed.env ?? {}),
          seed.keepaliveSeconds ?? 15,
          now,
          now,
        );
      }
    });
    for (const seed of seeds) {
      if (seed.trust) await this.trustKey(ids[seed.name]!, seed.port);
    }
    return ids;
  }

  /** Trusts the test sshd host key of `port` for this server's address. */
  async trustKey(serverId: string, port: number): Promise<void> {
    await this.api('POST', `/servers/${serverId}/trust-key`, {
      actingUserId: this.userId,
      ...knownHostKey(port),
    });
  }

  async createSession(serverId: string, label: string): Promise<string> {
    const { sessionId } = await this.api<{ sessionId: string }>('POST', '/sessions', {
      actingUserId: this.userId,
      serverId,
      label,
      viewport: { cols: 120, rows: 32 },
    });
    return sessionId;
  }

  /** Waits for a user-facing status (connected, reconnecting, disconnected, ended…). */
  async waitStatus(sessionId: string, wanted: string[], timeoutMs = 90_000): Promise<string> {
    let last = '';
    await this.#until(
      async () => {
        const { sessions } = await this.api<{
          sessions: Array<{ sessionId: string; status: string }>;
        }>('GET', `/sessions?actingUserId=${encodeURIComponent(this.userId)}`);
        last = sessions.find((s) => s.sessionId === sessionId)?.status ?? '';
        return wanted.includes(last);
      },
      `session ${sessionId} to be ${wanted.join(' or ')}`,
      timeoutMs,
    ).catch((err: Error) => {
      throw new Error(`${err.message} (last status: ${last || 'none'})`);
    });
    return last;
  }

  async setFrame(frame: Frame, height = frame.height): Promise<void> {
    await this.page.send('Emulation.setDeviceMetricsOverride', {
      width: frame.width,
      height,
      deviceScaleFactor: frame.scale,
      mobile: frame.mobile,
      screenWidth: frame.width,
      screenHeight: height,
    });
    await this.page.send('Emulation.setTouchEmulationEnabled', { enabled: frame.mobile });
    await sleep(300);
  }

  /** Fonts loaded and two frames painted. */
  async settle(): Promise<void> {
    await this.page.evaluate(
      `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`,
    );
    await sleep(250);
  }

  /**
   * One screenshot `<name>[-full]-<frame>.png` in `out`. Phone frames also check that nothing
   * scrolls sideways; `full` grows the viewport to the page's height first.
   */
  async shot(
    name: string,
    frame: Frame,
    options: { full?: boolean; file?: string } = {},
  ): Promise<void> {
    await this.setFrame(frame);
    await this.settle();
    if (frame.mobile) {
      const overflow = await this.page.evaluate<{
        scrollWidth: number;
        innerWidth: number;
        wide: string[];
      }>(`(() => {
        const innerWidth = window.innerWidth;
        const scrolls = (node) => { for (let p = node.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
        const wide = $$('body *').filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed'
            && !el.closest('[aria-hidden="true"], .sr-only, .xterm') && !scrolls(el);
        }).slice(0, 8).map((el) => el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 60));
        return { scrollWidth: document.documentElement.scrollWidth, innerWidth, wide };
      })()`);
      this.check(
        `noHorizontalScroll:${name}`,
        overflow.scrollWidth <= overflow.innerWidth && overflow.wide.length === 0,
        overflow,
      );
    }
    if (options.full) {
      const height = await this.page.evaluate<number>('document.documentElement.scrollHeight');
      await this.setFrame(frame, Math.max(frame.height, height));
      await this.settle();
    }
    const path = join(
      this.out,
      options.file ?? `${name}${options.full ? '-full' : ''}-${frame.name}.png`,
    );
    await this.page.screenshot(path);
    this.#written.push(path);
    log(`shot ${path}`);
    if (options.full) await this.setFrame(frame);
  }

  /** The same scene in several frames, back to the 1x desktop frame after. */
  async shots(name: string, frames: Frame[] = Object.values(FRAMES)): Promise<void> {
    for (const frame of frames) await this.shot(name, frame);
    await this.setFrame(FRAMES.desktop1x);
  }

  /** Types a line into the focused pane's terminal and presses Enter. */
  async typeLine(line: string): Promise<void> {
    await this.page.waitFor(
      `(() => { const t = $('.xterm-helper-textarea'); if (!t) return false; t.focus(); return document.activeElement === t; })()`,
      'the terminal to take focus',
    );
    await this.page.insertText(line);
    await this.page.pressEnter();
  }

  /** Drops the focus, so no focus ring or open tooltip shows in the next shot. */
  async blur(): Promise<void> {
    await this.page.evaluate(
      `(document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)`,
    );
  }

  async pressKey(key: string, code: string, keyCode: number): Promise<void> {
    const event = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  }

  /** Records a named check; finish() fails the run if any failed. */
  check(name: string, ok: boolean, detail: unknown): void {
    this.#measurements[name] = { ok, detail };
    log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
    if (!ok) this.#failures.push(name);
  }

  measure(name: string, value: unknown): void {
    this.#measurements[name] = value;
  }

  /** Writes console.json and measurements.json to `out`; throws if a check failed. */
  finish(): void {
    writeFileSync(join(this.out, 'console.json'), `${JSON.stringify(this.#console, null, 1)}\n`);
    writeFileSync(
      join(this.out, 'measurements.json'),
      `${JSON.stringify({ ...this.#measurements, written: this.#written }, null, 1)}\n`,
    );
    log(
      `console entries: ${this.#console.length}; failed checks: ${this.#failures.join(', ') || 'none'}`,
    );
    if (this.#failures.length) throw new Error(`failed checks: ${this.#failures.join(', ')}`);
  }

  /** Stops the browser, the daemon and web (whole process groups) and the sshd containers. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#browser) {
      await this.#browser.close().catch(() => {});
      this.#browser = null;
    }
    const signal = (sig: NodeJS.Signals) => {
      for (const child of this.#children) {
        if (!child.pid || child.exitCode !== null) continue;
        try {
          process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      }
    };
    signal('SIGTERM');
    await sleep(2_500);
    signal('SIGKILL');
    if (this.#sshdUp) {
      log('stopping the test sshd containers');
      this.compose(['down', '--timeout', '15']);
      this.#sshdUp = false;
    }
  }
}

/**
 * Runs one capture session: start, `scenes`, finish, stop. On failure it saves `failure.png`
 * and the reports, stops everything, and exits with code 1.
 */
export async function runCapture(
  options: CaptureOptions,
  scenes: (capture: Capture) => Promise<void>,
): Promise<never> {
  let capture: Capture | null = null;
  let code = 0;
  try {
    capture = await Capture.start(options);
    await scenes(capture);
    capture.finish();
  } catch (err) {
    code = 1;
    console.error(`capture failed: ${(err as Error).stack ?? err}`);
    if (capture) {
      await capture.page.screenshot(join(options.out, 'failure.png')).catch(() => {});
      try {
        capture.finish();
      } catch {
        // the failure is already reported
      }
    }
  } finally {
    await capture?.stop();
  }
  process.exit(code);
}
