// End-to-end smoke of the composed stack (pre-release routine, plan §15.4). Step 6 of
// `pnpm test:release`; also runnable alone once the images are built:
//
//   docker compose -p termdock-smoke -f deploy/compose.yaml build session-manager
//   docker compose -p termdock-smoke -f deploy/compose.yaml build web
//   node scripts/release-smoke.ts
//
// Isolated from any real install: compose project `termdock-smoke`, throwaway volumes, secrets
// from init-secrets.sh in a temporary directory, Caddy on loopback ports 18080/18443 and the
// test-only override test/release/compose.smoke.yaml (which adds a test sshd from the
// already-built test image, authenticated with the test-only keys of test/sshd/keys). Everything
// is torn down on success, failure and Ctrl-C (`down -v` for that project only).
//
// The real web UI is driven over the Chrome DevTools Protocol (scripts/cdp.ts) in a local
// headless Chromium: TERMDOCK_SMOKE_CHROME, else the newest
// ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell.
//
// Environment: TERMDOCK_SMOKE_CHROME, TERMDOCK_SMOKE_HTTP_PORT (18080),
// TERMDOCK_SMOKE_HTTPS_PORT (18443), TERMDOCK_SMOKE_MIN_AVAILABLE_MB (900), TMPDIR, and the
// override's TERMDOCK_SMOKE_SSHD_IMAGE (a test sshd image with tmux >= 3.2) and
// TERMDOCK_SMOKE_EDGE_SUBNET.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import en from '../apps/web/messages/en.json' with { type: 'json' };
import { type CdpPage, type Chromium, findChromium, launchChromium, sleep } from './cdp.ts';

const ROOT = join(import.meta.dirname, '..');
const PROJECT = 'termdock-smoke';
const COMPOSE_FILE = join(ROOT, 'deploy', 'compose.yaml');
const OVERRIDE = join(ROOT, 'test', 'release', 'compose.smoke.yaml');
const SCRIPTS = join(ROOT, 'deploy', 'scripts');
const KEYS = join(ROOT, 'test', 'sshd', 'keys');
const HTTP_PORT = Number(process.env.TERMDOCK_SMOKE_HTTP_PORT ?? 18080);
const HTTPS_PORT = Number(process.env.TERMDOCK_SMOKE_HTTPS_PORT ?? 18443);
const BASE = `https://localhost:${HTTPS_PORT}`;
const MIN_AVAILABLE_MB = Number(process.env.TERMDOCK_SMOKE_MIN_AVAILABLE_MB ?? 900);
const SSHD_IMAGE = process.env.TERMDOCK_SMOKE_SSHD_IMAGE ?? 'termdock-test-sshd:tmux-3.4';
const SSHD_SERVICE = 'smoke-sshd';
const SERVICES = ['caddy', 'web', 'session-manager', SSHD_SERVICE];
const APP_IMAGES = [`${PROJECT}-web`, `${PROJECT}-session-manager`];
const PROJECT_LABEL = `label=com.docker.compose.project=${PROJECT}`;

const ADMIN = { username: 'smokeadmin', email: 'smoke-admin@example.test' };
const NAMES = {
  credential: 'smoke-key',
  server: 'smoke-sshd',
  /** The second server, made with Duplicate (same address, same credential). */
  duplicate: en.servers.copyName.replace('{name}', 'smoke-sshd'),
  /** The first session's name after the rename check. */
  renamed: 'smoke-renamed',
};
/** The smoke server's sign-in, as rows and the Add server result show it (port 22 is implied). */
const TARGET = `td@${SSHD_SERVICE}`;
const LABELS = {
  restoring: en.workspace.status.restoring,
  connecting: en.workspace.status.connecting,
  newSession: en.workspace.bay.newSession,
  trust: en.workspace.hostKey.accept,
  terminate: en.workspace.menu.terminate,
  terminateConfirm: en.workspace.menu.terminateConfirm,
  rename: en.workspace.menu.rename,
  renameSave: en.workspace.rename.save,
  tabs: en.workspace.tabs.label,
  protected: en.workspace.protection['tmux-control'],
};
const ADD_SERVER = en.servers.addServer;

// ── output ──────────────────────────────────────────────────────────────────

class SmokeFailure extends Error {}

const results: Array<{ ok: boolean; line: string }> = [];
function pass(step: string, what: string): void {
  const line = `PASS  ${step.padEnd(12)} ${what}`;
  results.push({ ok: true, line });
  console.log(line);
}
function check(step: string, ok: boolean, what: string, detail = ''): void {
  if (ok) {
    pass(step, what);
    return;
  }
  const line = `FAIL  ${step.padEnd(12)} ${what}${detail ? `: ${detail}` : ''}`;
  results.push({ ok: false, line });
  console.log(line);
  throw new SmokeFailure(`${step}: ${what}${detail ? `: ${detail}` : ''}`);
}
function info(message: string): void {
  console.log(`smoke: ${message}`);
}

// ── processes ───────────────────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

let stopping = false;
const children = new Set<ReturnType<typeof spawn>>();

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; echo?: boolean; allowWhileStopping?: boolean } = {},
): Promise<RunResult> {
  if (stopping && !options.allowWhileStopping) {
    return Promise.reject(new SmokeFailure('interrupted'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    const echo = (chunk: string) => {
      if (!options.echo) return;
      for (const line of chunk.split('\n')) if (line.trim()) console.log(`  | ${line}`);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      echo(chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      echo(chunk.toString());
    });
    child.once('error', (err) => {
      children.delete(child);
      reject(err);
    });
    child.once('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// ── isolation: paths and the compose environment ────────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'termdock-smoke-'));
const secretsDir = join(tmpRoot, 'secrets');
const backupDir = join(tmpRoot, 'backups');
const chromeProfile = join(tmpRoot, 'chrome');

/** Every compose setting is pinned, so a deploy/.env of a real install never leaks in. */
const smokeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  COMPOSE_PROJECT_NAME: PROJECT,
  TERMDOCK_SMOKE_SSHD_IMAGE: SSHD_IMAGE,
  TERMDOCK_COMPOSE_OVERRIDE: OVERRIDE,
  TERMDOCK_SECRETS_DIR: secretsDir,
  TERMDOCK_BACKUP_DIR: backupDir,
  TERMDOCK_DOMAIN: 'localhost',
  TERMDOCK_HTTP_PORT: String(HTTP_PORT),
  TERMDOCK_HTTPS_PORT: String(HTTPS_PORT),
  TERMDOCK_PUBLIC_URL: BASE,
  TERMDOCK_TLS: 'internal',
  TERMDOCK_LOG_LEVEL: 'info',
  TERMDOCK_DAEMON_MEM_LIMIT: '1g',
  TERMDOCK_WEB_MEM_LIMIT: '768m',
  TERMDOCK_SSH_ALLOW_LOCAL_TARGETS: 'false',
  TERMDOCK_EVENT_RETENTION_DAYS: '180',
};

function compose(args: string[], echo = false, allowWhileStopping = false): Promise<RunResult> {
  return run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '-f', OVERRIDE, ...args], {
    env: smokeEnv,
    echo,
    allowWhileStopping,
  });
}

function deployScript(name: string, args: string[]): Promise<RunResult> {
  return run(join(SCRIPTS, name), args, { env: smokeEnv, echo: true });
}

async function projectLeftovers(): Promise<string[]> {
  const listings = await Promise.all([
    run('docker', ['ps', '-a', '--filter', PROJECT_LABEL, '--format', 'container {{.Names}}'], {
      allowWhileStopping: true,
    }),
    run('docker', ['volume', 'ls', '--filter', PROJECT_LABEL, '--format', 'volume {{.Name}}'], {
      allowWhileStopping: true,
    }),
    run('docker', ['network', 'ls', '--filter', PROJECT_LABEL, '--format', 'network {{.Name}}'], {
      allowWhileStopping: true,
    }),
  ]);
  return listings.flatMap((r) => r.stdout.split('\n').filter((line) => line.trim()));
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** OpenSSH-style SHA256 fingerprint of a public key line. */
function fingerprint(publicKeyLine: string): string {
  const blob = Buffer.from(publicKeyLine.trim().split(/\s+/)[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const js = (value: unknown) => JSON.stringify(value);

function chromium(): string {
  try {
    return findChromium();
  } catch (err) {
    throw new SmokeFailure((err as Error).message);
  }
}

function availableMb(): number {
  const line = readFileSync('/proc/meminfo', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('MemAvailable:'));
  return Math.floor(Number(line?.split(/\s+/)[1] ?? 0) / 1024);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Polls a Node-side probe until it returns a truthy value; the timeout error names `label`. */
async function until<T>(
  probe: () => T | null | undefined | false | '',
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}`);
    }
    await sleep(150);
  }
}

// ── page helpers ────────────────────────────────────────────────────────────

const stripOf = (sessionId: string) =>
  `($(${js(`a[href="/workspace?s=${encodeURIComponent(sessionId)}"]`)})?.closest('[data-status]') ?? null)`;

/** Session ids of the strips on the workspace. */
function stripIds(page: CdpPage): Promise<string[]> {
  return page.evaluate<string[]>(
    `$$('a[href^="/workspace?s="]').map((a) => decodeURIComponent(a.getAttribute('href').slice('/workspace?s='.length)))`,
  );
}

/** The terminal rows of every terminal on the page (xterm's DOM renderer), trimmed. */
const ROWS = `$$('.xterm-rows > div').map((row) => (row.textContent ?? '').replace(/\\u00a0/g, ' ').trimEnd())`;
const PROGRESS = `$$('[data-pane] [role=status]').map(text).filter((t) => t === ${js(LABELS.restoring)} || t === ${js(LABELS.connecting)})`;

async function setLocaleCookie(page: CdpPage): Promise<void> {
  await page.send('Network.setCookie', { name: 'NEXT_LOCALE', value: 'en', url: BASE });
}

async function waitConnected(page: CdpPage, sessionId: string, label: string): Promise<void> {
  await page.waitFor(
    `(() => { const s = ${stripOf(sessionId)}; return s?.dataset.status === 'connected' && ${PROGRESS}.length === 0; })()`,
    `${label} to be Connected`,
    120_000,
    250,
  );
}

/** Opens the palette and starts a session from the smoke server; returns the new id. */
async function startSession(page: CdpPage): Promise<string> {
  const before = new Set(await stripIds(page));
  await page.click(
    `$$('button').find((b) => visible(b) && text(b).startsWith(${js(LABELS.newSession)}))`,
    'the New session button',
  );
  // A server option (`v-<id>`), named exactly like the smoke server (not its copy, not a session).
  const option = `$$('[role=dialog] li[role=option]').find((li) => li.id.includes('-v-') && $$('span', li).some((s) => s.children.length === 0 && text(s) === ${js(NAMES.server)}))`;
  await page.click(option, 'the smoke server in the palette');
  return page.waitFor<string>(
    `$$('a[href^="/workspace?s="]').map((a) => decodeURIComponent(a.getAttribute('href').slice('/workspace?s='.length))).find((id) => !${js([...before])}.includes(id))`,
    'the new session strip',
    60_000,
  );
}

async function typeLine(page: CdpPage, line: string): Promise<void> {
  await page.waitFor(
    `(() => { const t = $('.xterm-helper-textarea'); if (!t) return false; t.focus(); return document.activeElement === t; })()`,
    'the terminal to take focus',
  );
  await page.insertText(line);
  await page.pressEnter();
}

async function waitForRow(page: CdpPage, exact: string, label: string): Promise<void> {
  await page.waitFor(`${ROWS}.some((row) => row.trim() === ${js(exact)})`, label, 30_000);
}

// ── the flow ────────────────────────────────────────────────────────────────

let browser: Chromium | null = null;
const cspViolations: string[] = [];
const pageErrors: string[] = [];

async function preflight(): Promise<string> {
  const chrome = chromium();
  info(`Chromium: ${chrome}`);
  const free = await run('free', ['-m']);
  for (const line of free.stdout.trimEnd().split('\n')) info(`free -m | ${line}`);
  const available = availableMb();
  check(
    'preflight',
    available >= MIN_AVAILABLE_MB,
    `${available} MB available (stack + test sshd + one headless Chromium need about ${MIN_AVAILABLE_MB} MB)`,
    'free memory first, or lower TERMDOCK_SMOKE_MIN_AVAILABLE_MB if you know it fits',
  );
  const images = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', ...APP_IMAGES]);
  check(
    'preflight',
    images.code === 0,
    `deployment images ${APP_IMAGES.join(', ')} are built`,
    'build them first (one at a time): docker compose -p termdock-smoke -f deploy/compose.yaml build session-manager && docker compose -p termdock-smoke -f deploy/compose.yaml build web',
  );
  const sshd = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', SSHD_IMAGE]);
  check(
    'preflight',
    sshd.code === 0,
    `test sshd image ${SSHD_IMAGE} is present`,
    'build it: docker compose -f test/sshd/compose.yaml build tmux-3.4',
  );
  const leftovers = await projectLeftovers();
  if (leftovers.length > 0) {
    info(`removing leftovers of an earlier smoke run: ${leftovers.join(', ')}`);
    await compose(['down', '-v', '--remove-orphans', '--timeout', '30'], true);
  }
  for (const port of [HTTP_PORT, HTTPS_PORT]) {
    check('preflight', await portFree(port), `port 127.0.0.1:${port} is free`);
  }
  return chrome;
}

async function startStack(): Promise<void> {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const secrets = await deployScript('init-secrets.sh', []);
  check(
    'stack',
    secrets.code === 0 && existsSync(join(secretsDir, 'master_key')),
    `init-secrets.sh wrote the secrets to a temporary directory (${secretsDir})`,
    `exit ${secrets.code}`,
  );
  info('starting the stack (compose up --wait; images are never built here)');
  const up = await compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '300'], true);
  check('stack', up.code === 0, `project ${PROJECT} is up and healthy`, `exit ${up.code}`);
}

async function setupAdmin(page: CdpPage, password: string): Promise<void> {
  // 1. The one-time setup token from web's log, then the first admin at /setup.
  let token = '';
  const deadline = Date.now() + 60_000;
  while (!token && Date.now() < deadline) {
    const logs = await compose(['logs', '--no-color', 'web']);
    token = [...logs.stdout.matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1)?.[1] ?? '';
    if (!token) await sleep(1_000);
  }
  check('1 setup', token.length > 0, "the one-time setup token is in web's log");
  await setLocaleCookie(page);
  await page.navigate(`${BASE}/setup`);
  await page.waitHydrated(`$('input[name=token]')?.closest('form')`, 'the setup form');
  const submit = async (value: string, label: string) => {
    // Every field again: the form resets after each answer of its action.
    await page.fill(`$('input[name=token]')`, value, label);
    await page.fill(`$('input[name=username]')`, ADMIN.username, 'username');
    await page.fill(`$('input[name=email]')`, ADMIN.email, 'email');
    await page.fill(`$('input[name=password]')`, password, 'password');
    await page.fill(`$('input[name=confirm]')`, password, 'confirmation');
    await page.click(
      `$('input[name=token]').closest('form').querySelector('button[type=submit]')`,
      'Create administrator',
    );
  };
  // A stale token is answered on the form, not with an error page: the error comes from the auth
  // runtime's bundle layer, which a plain `instanceof` in the Server Action misses.
  await submit(`${token}x`, 'a wrong setup token');
  await page.waitFor(
    `location.pathname === '/setup' && document.body.innerText.includes(${js(en.auth.setup.error.token)})`,
    'the wrong-token message on the setup form',
  );
  pass('1 setup', 'a wrong setup token is reported on the form');
  await submit(token, 'setup token');
  await page.waitFor(`location.pathname === '/workspace'`, 'the workspace after setup', 60_000);
  pass('1 setup', `first admin "${ADMIN.username}" created at /setup and signed in`);
  const status = await page.evaluate<number>(
    `fetch('/setup', { cache: 'no-store' }).then((r) => r.status)`,
  );
  check('1 setup', status === 404, '/setup is closed (404) once an admin exists', `HTTP ${status}`);
}

async function signIn(page: CdpPage, password: string): Promise<void> {
  // 2. A fresh sign-in: drop every cookie, then /login. Leave the signed-in page first: once its
  // cookie is gone it may navigate on its own and abort ours (net::ERR_ABORTED).
  await page.navigate('about:blank');
  await page.send('Network.clearBrowserCookies');
  await setLocaleCookie(page);
  await page.navigate(`${BASE}/workspace`);
  await page.waitFor(`location.pathname === '/login'`, 'the redirect to /login when signed out');
  await page.waitHydrated(`$('input[name=username]')?.closest('form')`, 'the login form');
  await page.fill(`$('input[name=username]')`, ADMIN.username, 'username');
  await page.fill(`$('input[name=password]')`, password, 'password');
  await page.click(
    `$('input[name=username]').closest('form').querySelector('button[type=submit]')`,
    'Sign in',
  );
  await page.waitFor(`location.pathname === '/workspace'`, 'the workspace after sign-in', 60_000);
  await page.waitFor(
    `$$('button').some((b) => visible(b) && text(b).startsWith(${js(LABELS.newSession)}))`,
    'the workspace to render',
  );
  check('2 sign-in', true, `signed out, then signed in as "${ADMIN.username}" at /login`);
}

/** The Add server result panel ("Server added", shown in place of the form). */
const DONE = `$(${js(`section[aria-label=${js(ADD_SERVER.done.title)}]`)})`;

/** Submits the Add server form; fails with the form's own errors when it refuses. */
async function submitAddServer(page: CdpPage, step: string, form: string): Promise<void> {
  await page.click(`${form}.querySelector('button[type=submit]')`, ADD_SERVER.submit);
  const outcome = await page.waitFor<string>(
    `(() => { if (${DONE}) return 'done'; const f = ${form}; if (!f) return ''; const errors = $$('[role=alert]', f).map(text).filter(Boolean); const invalid = $$('[aria-invalid="true"]', f).map((el) => el.name); return errors.length || invalid.length ? errors.concat(invalid).join('; ') : ''; })()`,
    'the Add server result',
    60_000,
  );
  check(step, outcome === 'done', `"${ADD_SERVER.done.title}" shown in place`, outcome);
  await page.waitHydrated(DONE, 'the Add server result');
}

/** What the Add server result shows: notice, the summary rows, the key fingerprint, the server. */
async function readAddServerDone(
  page: CdpPage,
  serverName: string,
): Promise<{ notice: string; rows: string[][]; fingerprint: string; serverId: string }> {
  const shown = await page.evaluate<{
    notice: string;
    rows: string[][];
    fingerprint: string;
    href: string;
  }>(
    `(() => { const d = ${DONE}; return { notice: text($('[role=status]', d)), rows: $$('dd', d).map((dd) => [...dd.children].map(text)), fingerprint: text($$('code', d).find((c) => text(c).startsWith('SHA256:'))), href: byText('a', ${js(ADD_SERVER.done.openServer.replace('{server}', serverName))}, d)?.getAttribute('href') ?? '' }; })()`,
  );
  const serverId = decodeURIComponent(/^\/servers\/([^/?#]+)$/.exec(shown.href)?.[1] ?? '');
  return { notice: shown.notice, rows: shown.rows, fingerprint: shown.fingerprint, serverId };
}

/**
 * "Start a session" on the Add server result: a Server Action that redirects to
 * /workspace?open=<id>. The workspace cleans that from the URL at once, so every URL the page
 * goes through is recorded. Returns the session id once the URL is clean and its row is the
 * followed one (the session shown in the focused pane).
 */
async function startFromResult(page: CdpPage): Promise<string> {
  const urls: string[] = [];
  const offs = [
    page.on('Page.navigatedWithinDocument', (params) => urls.push(String(params.url))),
    page.on('Page.frameNavigated', (params) => {
      const frame = params.frame as { url?: string; parentId?: string };
      if (!frame.parentId) urls.push(String(frame.url));
    }),
  ];
  let openUrl: URL;
  try {
    await page.click(
      `byText('button', ${js(ADD_SERVER.done.start)}, ${DONE})`,
      ADD_SERVER.done.start,
    );
    openUrl = await until(
      () =>
        urls
          .map((u) => new URL(u, BASE))
          .find((u) => u.pathname === '/workspace' && u.searchParams.has('open')),
      'the redirect to /workspace?open=<session id>',
    );
  } finally {
    for (const off of offs) off();
  }
  const sessionId = openUrl.searchParams.get('open') ?? '';
  await page.waitFor(
    `location.pathname === '/workspace' && !new URLSearchParams(location.search).has('open')`,
    'the workspace, with ?open= cleaned from the URL',
    60_000,
  );
  await page.waitHydrated(stripOf(sessionId), `the row of session ${sessionId}`, 60_000);
  await page.waitFor(
    `${stripOf(sessionId)}?.querySelector('a')?.getAttribute('aria-current') === 'true'`,
    `session ${sessionId} to be followed (shown in the focused pane)`,
  );
  return sessionId;
}

async function addServer(page: CdpPage): Promise<{ serverId: string; sessionId: string }> {
  // 3. "Add server" in one form (D-29): the server (name, address, port, user name) and the test
  // key pasted as a new credential. Then "Start a session" on the result, which lands in the
  // workspace through /workspace?open=<id>.
  const privateKey = readFileSync(join(KEYS, 'id_ed25519'), 'utf8');
  const userKeyFp = fingerprint(readFileSync(join(KEYS, 'id_ed25519.pub'), 'utf8'));
  await page.navigate(`${BASE}/servers/new`);
  const form = `$('input[name="server.hostname"]')?.closest('form')`;
  const field = (selector: string) => `${form}.querySelector(${js(selector)})`;
  await page.waitHydrated(form, 'the Add server form');
  await page.fill(field('input[name="server.name"]'), NAMES.server, 'server name');
  await page.fill(field('input[name="server.hostname"]'), SSHD_SERVICE, 'address');
  await page.fill(field('input[name="server.port"]'), '22', 'port');
  await page.fill(field('input[name="server.username"]'), 'td', 'user name on the server');
  await page.click(
    field('input[name="credential.mode"][value=private_key]'),
    `the "${ADD_SERVER.credential.choices.private_key}" option`,
  );
  await page.waitFor(
    `!!${field('textarea[name="credential.privateKey"]')}`,
    'the private key field',
  );
  await page.evaluate(
    `(() => { const el = ${field('textarea[name="credential.privateKey"]')}; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, ${js(privateKey)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
  await page.fill(field('input[name="credential.name"]'), NAMES.credential, 'credential name');
  const protection = await page.evaluate<string>(
    `${field('input[name="server.protectionMode"]:checked')}?.value ?? ''`,
  );
  check(
    '3 add server',
    protection === 'auto',
    'the server keeps the default session protection (auto)',
    `server.protectionMode: "${protection}"`,
  );
  await submitAddServer(page, '3 add server', form);

  const shown = await readAddServerDone(page, NAMES.server);
  const expected = [
    [NAMES.server, TARGET],
    [NAMES.credential, ADD_SERVER.done.kind.private_key],
  ];
  const body = ADD_SERVER.done.body.replace('{server}', NAMES.server).replace('{target}', TARGET);
  check(
    '3 add server',
    shown.notice.includes(body) && js(shown.rows) === js(expected) && shown.serverId.length > 0,
    `server "${NAMES.server}" → ${TARGET}:22 (${shown.serverId}) with credential ` +
      `"${NAMES.credential}" (${ADD_SERVER.done.kind.private_key}) added in one form`,
    `notice "${shown.notice}", rows ${js(shown.rows)}, server id "${shown.serverId}"`,
  );
  check(
    '3 add server',
    shown.fingerprint === userKeyFp,
    `the result shows the pasted key's fingerprint ${shown.fingerprint || '(none)'} (the test key)`,
    `expected ${userKeyFp}`,
  );

  const sessionId = await startFromResult(page);
  const ids = await stripIds(page);
  check(
    '3 add server',
    ids.length === 1 && ids[0] === sessionId,
    `"${ADD_SERVER.done.start}" led to /workspace?open=${sessionId}: the workspace opened it in ` +
      'the focused pane and cleaned the URL',
    `sessions on the page: ${ids.join(', ')}`,
  );
  return { serverId: shown.serverId, sessionId };
}

async function firstSession(page: CdpPage, sessionId: string, marker: string): Promise<void> {
  // 4. The session opened by "Start a session": trust the host key on first use, wait for
  // Connected and protected.
  const hostFp = fingerprint(readFileSync(join(KEYS, 'ssh_host_ed25519_key.pub'), 'utf8'));
  const trust = `byText('button', ${js(LABELS.trust)})`;
  await page.waitFor(`visible(${trust})`, 'the host-key prompt', 90_000);
  const shown = await page.evaluate<string>(
    `text($$('dd').find((d) => text(d).startsWith('SHA256:')))`,
  );
  check(
    '4 session',
    shown === hostFp,
    `host-key prompt shows the test sshd key ${shown}`,
    `expected ${hostFp}`,
  );
  await page.click(trust, 'Trust and connect');
  await waitConnected(page, sessionId, 'the first session');
  await page.waitFor(
    `$$('.xterm-rows > div').length > 0`,
    "xterm's DOM rows (with WebGL available xterm draws on a canvas the smoke cannot read)",
  );
  const protection = await page.evaluate<string>(
    `${stripOf(sessionId)}?.querySelector('[title]')?.getAttribute('title') ?? ''`,
  );
  check(
    '4 session',
    protection === LABELS.protected,
    `session ${sessionId} Connected and protected (tmux control mode)`,
    `protection: "${protection}"`,
  );

  // 5. A command and its output in xterm's rows.
  await typeLine(page, `echo ${marker}`);
  await waitForRow(page, marker, `the output line "${marker}"`);
  pass('5 command', `typed "echo ${marker}"; the output row reads "${marker}"`);
}

async function renameSession(page: CdpPage, sessionId: string): Promise<void> {
  // 6. Rename the followed session through its row menu's "Rename…" dialog; the new name shows
  // on its row and on its (active) tab.
  const strip = stripOf(sessionId);
  await page.click(
    `${strip}?.querySelector('button[aria-haspopup=menu]')`,
    `the actions menu of ${sessionId}`,
  );
  await page.click(
    `$$('[role=menuitem]').find((b) => visible(b) && text(b) === ${js(LABELS.rename)})`,
    LABELS.rename,
  );
  const input = `$('dialog[open] input[name=label]')`;
  await page.waitFor(`visible(${input}) && !!${input}.value`, 'the rename dialog, prefilled');
  const before = await page.evaluate<string>(`${input}.value`);
  await page.fill(input, NAMES.renamed, 'the new session name');
  await page.click(
    `$$('dialog[open] button').find((b) => visible(b) && text(b) === ${js(LABELS.renameSave)})`,
    LABELS.renameSave,
  );
  await page.waitFor(`!$('dialog[open]')`, 'the rename dialog to close');
  const names = `(() => { const leaves = (el) => (el ? $$('span', el).filter((s) => s.children.length === 0).map(text) : []); return { row: leaves(${strip}), tab: leaves($(${js(`nav[aria-label=${js(LABELS.tabs)}] button[aria-current="true"]`)})) }; })()`;
  let seen: { row: string[]; tab: string[] } = { row: [], tab: [] };
  try {
    seen = await page.waitFor(
      `(() => { const n = ${names}; return n.row.includes(${js(NAMES.renamed)}) && n.tab.includes(${js(NAMES.renamed)}) ? n : null; })()`,
      `the new name "${NAMES.renamed}" on the row and the tab`,
      30_000,
    );
  } catch {
    seen = await page.evaluate(names);
  }
  check(
    '6 rename',
    seen.row.includes(NAMES.renamed) && seen.tab.includes(NAMES.renamed),
    `session ${sessionId} renamed "${before}" → "${NAMES.renamed}" in the "${LABELS.rename}" dialog; ` +
      'its row and its tab show the new name',
    `row: ${seen.row.join(' | ')}; tab: ${seen.tab.join(' | ')}`,
  );
}

/** Records every strip status and pane progress chip into window.__smokeTrace. */
async function startTrace(page: CdpPage, sessionId: string): Promise<void> {
  await page.evaluate(`(() => {
    window.__smokeTrace = [];
    const record = () => {
      const s = ${stripOf(sessionId)}?.dataset.status ?? null;
      const c = ${PROGRESS}.join('|');
      const last = window.__smokeTrace.at(-1);
      if (!last || last.s !== s || last.c !== c) window.__smokeTrace.push({ t: Date.now(), s, c });
    };
    window.__smokeObserver?.disconnect();
    window.__smokeObserver = new MutationObserver(record);
    window.__smokeObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    record();
    return true;
  })()`);
}

async function readTrace(
  page: CdpPage,
): Promise<Array<{ t: number; s: string | null; c: string }>> {
  return page.evaluate(`window.__smokeTrace ?? []`);
}

async function restartAndRestore(page: CdpPage, sessionId: string, marker: string): Promise<void> {
  // 7. Restart session-manager; the protected session comes back with its screen.
  await startTrace(page, sessionId);
  const started = Date.now();
  const restart = await compose(['restart', 'session-manager'], true);
  check(
    '7 restore',
    restart.code === 0,
    'session-manager container restarted',
    `exit ${restart.code}`,
  );
  await page.waitFor(
    `(window.__smokeTrace ?? []).some((e) => e.c.includes(${js(LABELS.restoring)}) || e.s === 'restoring')`,
    '"Restoring…" in the pane',
    120_000,
  );
  await waitConnected(page, sessionId, 'the restored session');
  const trace = await readTrace(page);
  const firstRestoring = trace.findIndex(
    (e) => e.c.includes(LABELS.restoring) || e.s === 'restoring',
  );
  const lastEntry = trace.at(-1);
  const summary = trace
    .map((e) => `${((e.t - started) / 1000).toFixed(1)}s ${e.s}${e.c ? ` [${e.c}]` : ''}`)
    .join(' → ');
  info(`status trace: ${summary}`);
  check(
    '7 restore',
    firstRestoring >= 0 && lastEntry?.s === 'connected' && lastEntry.c === '',
    'the pane showed "Restoring…", then the session was Connected again',
    summary,
  );
  // "Connected" can show a moment before xterm has drawn the restored snapshot (its writes are
  // asynchronous), so give the rows a few seconds rather than reading them once.
  const restored = await page
    .waitFor<boolean>(`${ROWS}.some((row) => row.trim() === ${js(marker)})`, 'the rows', 10_000)
    .then(
      () => true,
      () => false,
    );
  check(
    '7 restore',
    restored,
    `the earlier output "${marker}" is still on screen after the restart`,
  );
}

async function rotateAndReconnect(page: CdpPage, firstId: string, marker: string): Promise<string> {
  // 8. Rotate the master key, then a new session with the same (re-encrypted) credential.
  const keyFile = join(secretsDir, 'master_key');
  const before = sha256(readFileSync(keyFile));
  await startTrace(page, firstId);
  const rotate = await deployScript('rotate-master-key.sh', ['--yes']);
  check(
    '8 rotate',
    rotate.code === 0,
    'rotate-master-key.sh --yes finished',
    `exit ${rotate.code}`,
  );
  const after = sha256(readFileSync(keyFile));
  const old = existsSync(`${keyFile}.old`) ? sha256(readFileSync(`${keyFile}.old`)) : '';
  check(
    '8 rotate',
    after !== before && old === before,
    'master_key replaced; the previous key kept as master_key.old',
  );
  // The script restarted session-manager: wait until the browser saw it and came back.
  await page.waitFor(
    `(window.__smokeTrace ?? []).some((e) => e.c.includes(${js(LABELS.restoring)}) || e.s === 'restoring')`,
    'the pane to notice the session-manager restart',
    120_000,
  );
  await waitConnected(page, firstId, 'the first session after the rotation restart');
  pass('8 rotate', 'the first (protected) session was restored on the new key');
  const secondId = await startSession(page);
  await waitConnected(page, secondId, 'the second session');
  const trustPrompt = await page.evaluate<boolean>(
    `visible(byText('button', ${js(LABELS.trust)}))`,
  );
  check('8 rotate', !trustPrompt, `new session ${secondId} Connected with the stored credential`);
  await typeLine(page, `echo ${marker}`);
  await waitForRow(page, marker, `the output line "${marker}"`);
  pass('8 rotate', `the credential decrypts under the new key: "echo ${marker}" answered`);
  return secondId;
}

async function duplicateServer(page: CdpPage, serverId: string): Promise<string> {
  // 9. Duplicate the smoke server (D-29) on its page, save the copy unchanged (same address,
  // same saved credential) and start a session from it: host-key trust is per address, so it
  // connects with no host-key prompt.
  const before = await stripIds(page);
  await page.navigate(`${BASE}/servers/${encodeURIComponent(serverId)}`);
  const duplicate = `byText('a', ${js(en.servers.duplicate)})`;
  await page.waitHydrated(duplicate, 'the Duplicate action on the server page');
  await page.click(duplicate, en.servers.duplicate);
  await page.waitFor(
    `location.pathname === '/servers/new' && new URLSearchParams(location.search).get('duplicate') === ${js(serverId)}`,
    'Add server, prefilled from the smoke server',
  );
  const form = `$('input[name="server.hostname"]')?.closest('form')`;
  await page.waitHydrated(form, 'the prefilled Add server form');
  const prefill = await page.evaluate<Record<string, string>>(
    `(() => { const f = ${form}; const value = (name) => f.querySelector('[name="' + name + '"]')?.value ?? ''; const saved = f.querySelector('select[name="credential.id"]'); return { name: value('server.name'), hostname: value('server.hostname'), port: value('server.port'), username: value('server.username'), mode: f.querySelector('input[name="credential.mode"]:checked')?.value ?? '', credential: text(saved?.selectedOptions[0]) }; })()`,
  );
  const expectedPrefill = {
    name: NAMES.duplicate,
    hostname: SSHD_SERVICE,
    port: '22',
    username: 'td',
    mode: 'saved',
    credential: NAMES.credential,
  };
  check(
    '9 duplicate',
    js(prefill) === js(expectedPrefill),
    `Duplicate prefills "${NAMES.duplicate}": ${TARGET}:22 with the saved credential "${NAMES.credential}"`,
    js(prefill),
  );
  await submitAddServer(page, '9 duplicate', form);
  const shown = await readAddServerDone(page, NAMES.duplicate);
  const expected = [
    [NAMES.duplicate, TARGET],
    [NAMES.credential, ADD_SERVER.done.kind.saved],
  ];
  check(
    '9 duplicate',
    js(shown.rows) === js(expected) && shown.serverId.length > 0 && shown.serverId !== serverId,
    `second server "${NAMES.duplicate}" saved (${shown.serverId}): same address, same credential`,
    `rows ${js(shown.rows)}, server id "${shown.serverId}"`,
  );

  const sessionId = await startFromResult(page);
  const ids = await stripIds(page);
  check(
    '9 duplicate',
    !before.includes(sessionId) && ids.length === before.length + 1 && ids.includes(sessionId),
    `"${ADD_SERVER.done.start}" opened session ${sessionId} from the copy via ?open=`,
    `before: ${before.join(', ')}; now: ${ids.join(', ')}`,
  );
  // Connected, or a host-key prompt: whichever comes first decides.
  const outcome = await page.waitFor<string>(
    `(() => { if (visible(byText('button', ${js(LABELS.trust)}))) return 'a host-key prompt appeared'; const s = ${stripOf(sessionId)}; return s?.dataset.status === 'connected' && ${PROGRESS}.length === 0 ? 'connected' : ''; })()`,
    `session ${sessionId} to be Connected (or a host-key prompt)`,
    120_000,
    250,
  );
  check(
    '9 duplicate',
    outcome === 'connected',
    `session ${sessionId} Connected with no host-key prompt (trust is per address)`,
    outcome,
  );
  return sessionId;
}

async function terminate(page: CdpPage, ids: string[]): Promise<void> {
  // 10. Terminate every session through its strip menu.
  for (const id of ids) {
    const strip = stripOf(id);
    await page.click(
      `${strip}?.querySelector('button[aria-haspopup=menu]')`,
      `the actions menu of ${id}`,
    );
    await page.click(
      `$$('[role=menuitem]').find((b) => visible(b) && text(b) === ${js(LABELS.terminate)})`,
      'End…',
    );
    await page.click(`byText('button', ${js(LABELS.terminateConfirm)})`, 'End session');
    await page.waitFor(`${strip}?.dataset.status === 'ended'`, `session ${id} to end`, 60_000);
    pass('10 terminate', `session ${id} terminated (Ended)`);
  }
}

async function backup(ids: string[], renamedId: string): Promise<void> {
  // 11. An online backup through backup.sh, checked independently.
  const dest = join(backupDir, 'smoke');
  const result = await deployScript('backup.sh', [dest]);
  const file = result.stdout.trim().split('\n').at(-1) ?? '';
  check(
    '11 backup',
    result.code === 0 && existsSync(file),
    `backup.sh wrote ${file}`,
    `exit ${result.code}`,
  );
  check(
    '11 backup',
    result.stderr.includes('integrity_check: ok'),
    "backup.sh's own integrity check passed inside the container",
  );
  check(
    '11 backup',
    readFileSync(file).subarray(0, 15).toString() === 'SQLite format 3',
    'the file is a SQLite database',
  );
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    const count = (table: string) =>
      Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    const sessions = db.prepare('SELECT id, desired_state, label FROM sessions').all() as Array<{
      id: string;
      desired_state: string;
      label: string;
    }>;
    check(
      '11 backup',
      Object.values(integrity)[0] === 'ok',
      'PRAGMA integrity_check on the host copy: ok',
    );
    const servers = db.prepare('SELECT hostname, port, credential_id FROM servers').all() as Array<{
      hostname: string | null;
      port: number | null;
      credential_id: string | null;
    }>;
    const counts = `users ${count('user')}, servers ${servers.length}, credentials ${count('credentials')}, sessions ${sessions.length}`;
    check(
      '11 backup',
      count('user') === 1 &&
        servers.length === 2 &&
        servers.every(
          (s) =>
            s.hostname === SSHD_SERVICE &&
            s.port === 22 &&
            s.credential_id !== null &&
            s.credential_id === servers[0]?.credential_id,
        ) &&
        count('credentials') === 1 &&
        sessions.length === ids.length &&
        sessions.every((s) => ids.includes(s.id) && s.desired_state === 'terminated'),
      `the backup holds this run's data (${counts}; both servers at ${SSHD_SERVICE}:22 with the ` +
        `same credential; all ${ids.length} sessions terminated)`,
      js(servers),
    );
    const hostFp = fingerprint(readFileSync(join(KEYS, 'ssh_host_ed25519_key.pub'), 'utf8'));
    const keys = db
      .prepare('SELECT hostname, port, status, fingerprint_sha256 FROM known_host_keys')
      .all() as Array<{
      hostname: string;
      port: number;
      status: string;
      fingerprint_sha256: string;
    }>;
    const atAddress = keys.filter((k) => k.hostname === SSHD_SERVICE && k.port === 22);
    check(
      '11 backup',
      atAddress.length === 1 &&
        atAddress[0]?.status === 'trusted' &&
        atAddress[0]?.fingerprint_sha256 === hostFp,
      `known_host_keys holds exactly one row for ${SSHD_SERVICE}:22, trusted, with the test sshd key`,
      js(keys),
    );
    const stored = sessions.find((s) => s.id === renamedId)?.label;
    check(
      '11 backup',
      stored === NAMES.renamed,
      `the rename is stored: session ${renamedId} is labelled "${NAMES.renamed}"`,
      `label: "${stored}"`,
    );
  } finally {
    db.close();
  }
}

// ── failure diagnostics and teardown ────────────────────────────────────────

async function diagnostics(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'termdock-smoke-failure-'));
  if (browser) {
    try {
      const shot = join(dir, 'screenshot.png');
      await browser.page.screenshot(shot);
      console.log(`smoke: screenshot of the page: ${shot}`);
      const url = await browser.page.evaluate<string>('location.href');
      console.log(`smoke: page URL at failure: ${url}`);
    } catch (err) {
      console.log(`smoke: no screenshot (${(err as Error).message})`);
    }
  }
  for (const error of pageErrors.slice(-20)) console.log(`smoke: page error: ${error}`);
  for (const service of SERVICES) {
    const logs = await compose(['logs', '--no-color', '--tail', '100', service], false, true);
    console.log(`\n── last 100 log lines of ${service} ──`);
    console.log((logs.stdout + logs.stderr).trimEnd() || '(none)');
  }
  console.log(`\nsmoke: failure artifacts kept in ${dir}`);
}

let teardownDone: Promise<boolean> | null = null;
function teardown(): Promise<boolean> {
  teardownDone ??= (async () => {
    stopping = true;
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      info('Chromium stopped');
    }
    for (const child of children) child.kill('SIGTERM');
    info(`tearing down project ${PROJECT} (down -v: its containers, networks and volumes only)`);
    await compose(['down', '-v', '--remove-orphans', '--timeout', '30'], true, true);
    rmSync(tmpRoot, { recursive: true, force: true });
    const leftovers = await projectLeftovers();
    const clean = leftovers.length === 0 && !existsSync(tmpRoot);
    const line = clean
      ? `PASS  ${'teardown'.padEnd(12)} no container, network or volume of ${PROJECT} left; temporary secrets removed`
      : `FAIL  ${'teardown'.padEnd(12)} left behind: ${[...leftovers, ...(existsSync(tmpRoot) ? [tmpRoot] : [])].join(', ')}`;
    results.push({ ok: clean, line });
    console.log(line);
    return clean;
  })();
  return teardownDone;
}

let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    console.log(`\nsmoke: ${signal}: stopping and tearing down`);
    void teardown().finally(() => process.exit(130));
  });
}

async function main(): Promise<number> {
  const started = Date.now();
  const password = `Smoke-${randomBytes(12).toString('base64url')}`;
  const nonce = randomBytes(4).toString('hex');
  const markers = [`termdock-smoke-${nonce}`, `termdock-smoke-${nonce}-2`];
  let failed = false;
  try {
    const chrome = await preflight();
    await startStack();
    browser = await launchChromium({
      executable: chrome,
      userDataDir: chromeProfile,
      args: [
        // Caddy's local CA: trusted by this throwaway browser profile only.
        '--ignore-certificate-errors',
        // No WebGL: xterm falls back to its DOM renderer, whose rows the smoke reads.
        '--disable-3d-apis',
        '--window-size=1366,900',
        '--lang=en-US',
      ],
    });
    const { page } = browser;
    await page.send('Runtime.addBinding', { name: '__smokeCsp' });
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('securitypolicyviolation', (e) => window.__smokeCsp?.(location.pathname + ': ' + e.effectiveDirective + ' blocked ' + (e.blockedURI || '(inline)') + ' at ' + (e.sourceFile || '?') + ':' + e.lineNumber + ':' + e.columnNumber));`,
    });
    page.on('Runtime.bindingCalled', (params) => {
      if (params.name === '__smokeCsp') cspViolations.push(String(params.payload));
    });
    page.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails as {
        exception?: { description?: string };
        text?: string;
      };
      pageErrors.push(details.exception?.description ?? details.text ?? 'unknown');
    });

    await setupAdmin(page, password);
    await signIn(page, password);
    const { serverId, sessionId: firstId } = await addServer(page);
    await firstSession(page, firstId, markers[0] ?? '');
    await renameSession(page, firstId);
    await restartAndRestore(page, firstId, markers[0] ?? '');
    const secondId = await rotateAndReconnect(page, firstId, markers[1] ?? '');
    const thirdId = await duplicateServer(page, serverId);
    await terminate(page, [thirdId, secondId, firstId]);
    check(
      'csp',
      cspViolations.length === 0,
      'no Content-Security-Policy violation reported during the flow',
      cspViolations.slice(0, 5).join('; '),
    );
    await browser.close();
    browser = null;
    info('Chromium stopped (flow finished)');
    await backup([firstId, secondId, thirdId], firstId);
  } catch (err) {
    failed = true;
    // Interrupted: the signal handler tears down; the browser it closed is not a finding.
    if (interrupted) return 130;
    if (!(err instanceof SmokeFailure)) {
      const line = `FAIL  ${'error'.padEnd(12)} ${(err as Error).message}`;
      results.push({ ok: false, line });
      console.log(line);
    }
    await diagnostics();
  }
  const clean = await teardown();
  const ok = !failed && clean && results.every((r) => r.ok);
  console.log(`\nsmoke: ${ok ? 'PASS' : 'FAIL'} in ${Math.round((Date.now() - started) / 1000)} s`);
  return ok ? 0 : 1;
}

process.exitCode = await main();
