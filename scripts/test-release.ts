// Pre-release routine T2 (plan §15.4, D-25): `pnpm test:release`.
//
//   pnpm test:release [--only <step>[,<step>...]] [--from <step>]
//
// Steps, strictly one after another, stopping at the first failure:
//   guard  supply-chain guard: no plain-crypto-js, no axios 1.14.1 / 0.30.4 (lockfile, node_modules)
//   t0     pnpm check
//   t1     every T1 file (*.int.test.ts) exactly once, one file at a time, by area; needs the test
//          sshd containers (docker compose -f test/sshd/compose.yaml up -d --build)
//   osv    OSV scan of pnpm-lock.yaml against scripts/osv-allowlist.json (scripts/osv-scan.ts)
//   build  docker compose build of the deployment images, project termdock-smoke
//   smoke  scripts/release-smoke.ts against the composed stack
//
// Heavy steps run under `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0` when a
// user systemd is available (TERMDOCK_RELEASE_MEMORY_MAX, default 1500M), plain otherwise.
// Docker builds run inside dockerd, outside that cap. T1 runs the tmux suites against the whole
// D-22 matrix (TD_TMUX_IMAGES, default tmux-3.2a,tmux-3.4,tmux-edge; TERMDOCK_RELEASE_TMUX_IMAGES).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { AREAS } from './test-area.ts';

const ROOT = join(import.meta.dirname, '..');
const MEMORY_MAX = process.env.TERMDOCK_RELEASE_MEMORY_MAX ?? '1500M';
const TMUX_IMAGES = process.env.TERMDOCK_RELEASE_TMUX_IMAGES ?? 'tmux-3.2a,tmux-3.4,tmux-edge';
const SMOKE_PROJECT = 'termdock-smoke';
const SSHD = [
  { name: 'no-tmux', port: 2201 },
  { name: 'tmux-3.2a', port: 2202 },
  { name: 'tmux-3.4', port: 2203 },
  { name: 'tmux-edge', port: 2204 },
];

type Result = 'PASS' | 'FAIL' | 'SKIP' | 'NOT RUN';
interface Step {
  id: string;
  title: string;
  run(): Promise<boolean> | boolean;
}

let interrupted = false;
process.on('SIGINT', () => {
  // The running child gets the same SIGINT (and cleans up, e.g. the smoke's teardown); this
  // process waits for it, then stops and prints the summary.
  interrupted = true;
});

const say = (message: string) => console.log(`release: ${message}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const canCap =
  spawnSync('systemd-run', ['--user', '--scope', '-q', 'true'], { stdio: 'ignore' }).status === 0;

/** Runs a command in the foreground (inherited stdio), memory-capped when `cap` is set. */
function exec(
  command: string,
  args: string[],
  options: { cap?: boolean; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const [cmd, argv] =
    options.cap && canCap
      ? [
          'systemd-run',
          [
            '--user',
            '--scope',
            '-q',
            '-p',
            `MemoryMax=${MEMORY_MAX}`,
            '-p',
            'MemorySwapMax=0',
            command,
            ...args,
          ],
        ]
      : [command, args];
  const result = spawnSync(cmd, argv, {
    cwd: ROOT,
    stdio: 'inherit',
    env: options.env ?? process.env,
  });
  if (result.error) {
    say(`cannot run ${command}: ${result.error.message}`);
    return false;
  }
  if (result.signal === 'SIGKILL' || result.status === 137) {
    say(
      `${command} was killed (SIGKILL / exit 137): most likely the memory cap ` +
        `(MemoryMax=${MEMORY_MAX}) was hit. Report it; do not just raise the cap.`,
    );
    return false;
  }
  if (result.signal) say(`${command} stopped by ${result.signal}`);
  return result.status === 0;
}

// ── guard ───────────────────────────────────────────────────────────────────

const BAD_LOCK_PATTERNS = [
  /plain-crypto-js/,
  /\baxios@(?:1\.14\.1|0\.30\.4)\b/,
  /\baxios-(?:1\.14\.1|0\.30\.4)\.tgz\b/,
  /^\s+axios: (?:1\.14\.1|0\.30\.4)\b/,
];

function nodeModulesDirs(): string[] {
  const dirs = [join(ROOT, 'node_modules')];
  for (const group of ['apps', 'packages']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) dirs.push(join(base, name, 'node_modules'));
  }
  return dirs.filter((dir) => existsSync(dir));
}

function guard(): boolean {
  const findings: string[] = [];
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8').split('\n');
  lock.forEach((line, index) => {
    if (BAD_LOCK_PATTERNS.some((pattern) => pattern.test(line))) {
      findings.push(`pnpm-lock.yaml:${index + 1}: ${line.trim()}`);
    }
  });
  const store = join(ROOT, 'node_modules', '.pnpm');
  const storeEntries = existsSync(store) ? readdirSync(store) : [];
  for (const entry of storeEntries) {
    if (/^plain-crypto-js@/.test(entry) || /^axios@(?:1\.14\.1|0\.30\.4)(?:$|[_(])/.test(entry)) {
      findings.push(`node_modules/.pnpm/${entry}`);
    }
  }
  const dirs = nodeModulesDirs();
  for (const dir of dirs) {
    if (existsSync(join(dir, 'plain-crypto-js'))) findings.push(join(dir, 'plain-crypto-js'));
    const axios = join(dir, 'axios', 'package.json');
    if (existsSync(axios)) {
      const { version } = JSON.parse(readFileSync(axios, 'utf8')) as { version?: string };
      if (version === '1.14.1' || version === '0.30.4') findings.push(`${axios} (${version})`);
    }
  }
  if (findings.length > 0) {
    console.log('');
    console.log('!!! SUPPLY-CHAIN ALERT: known malicious package versions found !!!');
    console.log(
      '    (GHSA-fw8c-xr5c-95f9, GHSA-2x9r-6wxq-hrr7: plain-crypto-js, axios 1.14.1 / 0.30.4)',
    );
    for (const finding of findings) console.log(`    ${finding}`);
    console.log('    Stop: run no install, update, build or project script on this machine.');
    console.log('    Treat it as fully compromised and rotate secrets from another machine.');
    console.log('');
    return false;
  }
  say(
    `guard: no plain-crypto-js and no axios 1.14.1 / 0.30.4 in pnpm-lock.yaml (${lock.length} lines), ` +
      `node_modules/.pnpm (${storeEntries.length} entries) or ${dirs.length} node_modules directories`,
  );
  return true;
}

// ── t1 ──────────────────────────────────────────────────────────────────────

function sshBanner(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3_000, () => done(false));
    socket.once('error', () => done(false));
    socket.once('data', (data) => done(data.toString().startsWith('SSH-')));
  });
}

/** The files vitest itself considers T1 (project `t1` of vitest.config.ts). */
function discoverT1(): string[] | null {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'list', '--project', 't1', '--filesOnly'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    say(`vitest list failed:\n${result.stdout}${result.stderr}`);
    return null;
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('[t1] '))
    .map((line) => line.slice('[t1] '.length).trim())
    .sort();
}

const OTHER = 'other (outside the areas)';

/** Assigns every T1 file to exactly one bucket: the area whose path contains it, or OTHER. */
function bucketize(files: string[]): {
  buckets: Map<string, string[]>;
  problems: string[];
} {
  const areas = Object.entries(AREAS).filter(([, paths]) => paths.length > 0);
  const buckets = new Map<string, string[]>([...areas.map(([n]) => [n, []] as [string, string[]])]);
  buckets.set(OTHER, []);
  const problems: string[] = [];
  for (const file of files) {
    const owners = areas
      .filter(([, paths]) => paths.some((p) => file === p || file.startsWith(`${p}/`)))
      .map(([name]) => name);
    if (owners.length > 1) problems.push(`${file} is in several areas: ${owners.join(', ')}`);
    buckets.get(owners[0] ?? OTHER)?.push(file);
  }
  return { buckets, problems };
}

async function t1(): Promise<boolean> {
  const down: string[] = [];
  for (const target of SSHD) {
    if (!(await sshBanner(target.port))) down.push(`${target.name} (127.0.0.1:${target.port})`);
  }
  if (down.length > 0) {
    say(`t1: test sshd containers not reachable: ${down.join(', ')}`);
    say('t1: start them (this routine never starts or stops them):');
    say('       docker compose -f test/sshd/compose.yaml up -d --build');
    return false;
  }
  say(`t1: test sshd containers answer on 127.0.0.1:${SSHD.map((s) => s.port).join(', ')}`);

  const files = discoverT1();
  if (!files) return false;
  if (files.length === 0) {
    say('t1: vitest lists no T1 files');
    return false;
  }
  const { buckets, problems } = bucketize(files);
  const order = [...buckets.entries()].flatMap(([area, list]) =>
    list.map((file) => ({ area, file })),
  );
  say(`t1: coverage — vitest lists ${files.length} T1 files (project t1, *.int.test.ts):`);
  for (const [area, list] of buckets) {
    say(`  ${area}: ${list.length === 0 ? '(no T1 files)' : ''}`);
    for (const file of list) say(`    ${file}`);
  }
  const once = new Set(order.map((o) => o.file));
  const exact =
    problems.length === 0 &&
    order.length === files.length &&
    once.size === files.length &&
    files.every((file) => once.has(file));
  if (!exact) {
    for (const problem of problems) say(`t1: ${problem}`);
    say('t1: FAIL: the run plan does not cover every T1 file exactly once');
    return false;
  }
  say(`t1: run plan covers all ${files.length} files exactly once (union of areas + other)`);
  say(`t1: tmux suites run against TD_TMUX_IMAGES=${TMUX_IMAGES}`);

  const env = { ...process.env, TD_TMUX_IMAGES: TMUX_IMAGES };
  for (const [index, { area, file }] of order.entries()) {
    const started = Date.now();
    say(`t1: [${index + 1}/${order.length}] ${area}: ${file}`);
    const ok = exec('pnpm', ['exec', 'vitest', 'run', '--project', 't1', file], { cap: true, env });
    say(
      `t1: [${index + 1}/${order.length}] ${ok ? 'PASS' : 'FAIL'} ${file} (${seconds(Date.now() - started)})`,
    );
    if (!ok || interrupted) return false;
  }
  return true;
}

// ── build ───────────────────────────────────────────────────────────────────

function build(): boolean {
  say('build: Docker builds run inside dockerd, so the memory cap cannot apply to them;');
  say('build: they run alone, one image at a time.');
  for (const service of ['session-manager', 'web']) {
    const started = Date.now();
    const ok = exec('docker', [
      'compose',
      '-p',
      SMOKE_PROJECT,
      '-f',
      join(ROOT, 'deploy', 'compose.yaml'),
      'build',
      service,
    ]);
    say(`build: ${service} ${ok ? 'built' : 'FAILED'} in ${seconds(Date.now() - started)}`);
    if (!ok || interrupted) return false;
  }
  return true;
}

// ── the routine ─────────────────────────────────────────────────────────────

const STEPS: Step[] = [
  { id: 'guard', title: 'Supply-chain guard', run: guard },
  { id: 't0', title: 'T0: pnpm check', run: () => exec('pnpm', ['check'], { cap: true }) },
  { id: 't1', title: 'T1: every integration file, one at a time', run: t1 },
  {
    id: 'osv',
    title: 'OSV scan of pnpm-lock.yaml',
    run: () => exec('node', [join(ROOT, 'scripts', 'osv-scan.ts')]),
  },
  { id: 'build', title: 'Docker image build (termdock-smoke)', run: build },
  {
    id: 'smoke',
    title: 'Smoke against the composed stack',
    run: () => exec('node', [join(ROOT, 'scripts', 'release-smoke.ts')], { cap: true }),
  },
];

function selection(args: string[]): Set<string> {
  const ids = STEPS.map((s) => s.id);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const only = value('--only');
  const from = value('--from');
  const unknown = [...(only?.split(',') ?? []), ...(from ? [from] : [])].filter(
    (id) => !ids.includes(id),
  );
  if (
    unknown.length > 0 ||
    args.some((a) => a.startsWith('--') && a !== '--only' && a !== '--from')
  ) {
    console.error(`usage: pnpm test:release [--only <${ids.join('|')}>[,...]] [--from <step>]`);
    process.exit(2);
  }
  if (only) return new Set(only.split(','));
  if (from) return new Set(ids.slice(ids.indexOf(from)));
  return new Set(ids);
}

async function main(): Promise<number> {
  const selected = selection(process.argv.slice(2));
  const started = Date.now();
  say(`pre-release routine (plan §15.4): ${[...selected].join(' → ')}`);
  const free = spawnSync('free', ['-m'], { encoding: 'utf8' });
  for (const line of (free.stdout ?? '').trimEnd().split('\n')) say(`free -m | ${line}`);
  say(
    canCap
      ? `heavy steps capped: systemd-run --user --scope -p MemoryMax=${MEMORY_MAX} -p MemorySwapMax=0`
      : 'systemd-run --user is not available: heavy steps run uncapped, strictly one at a time',
  );
  const rows: Array<{ step: Step; result: Result; ms: number }> = [];
  let failed = false;
  for (const step of STEPS) {
    if (!selected.has(step.id)) {
      rows.push({ step, result: 'SKIP', ms: 0 });
      continue;
    }
    if (failed || interrupted) {
      rows.push({ step, result: 'NOT RUN', ms: 0 });
      continue;
    }
    console.log(
      `\n━━ ${step.id}: ${step.title} ${'━'.repeat(Math.max(0, 60 - step.title.length))}`,
    );
    const stepStarted = Date.now();
    let ok = false;
    try {
      ok = (await step.run()) && !interrupted;
    } catch (err) {
      say(`${step.id}: ${(err as Error).stack ?? String(err)}`);
    }
    const ms = Date.now() - stepStarted;
    rows.push({ step, result: ok ? 'PASS' : 'FAIL', ms });
    say(`${step.id}: ${ok ? 'PASS' : 'FAIL'} (${seconds(ms)})`);
    if (!ok) failed = true;
  }
  const total = Date.now() - started;
  const width = Math.max(...STEPS.map((s) => s.title.length));
  console.log(`\n━━ test:release summary ${'━'.repeat(width + 4)}`);
  console.log(`${'step'.padEnd(6)} ${'what'.padEnd(width)} ${'duration'.padStart(9)}  result`);
  for (const { step, result, ms } of rows) {
    const duration = result === 'PASS' || result === 'FAIL' ? seconds(ms) : '-';
    console.log(
      `${step.id.padEnd(6)} ${step.title.padEnd(width)} ${duration.padStart(9)}  ${result}`,
    );
  }
  const overall = failed || interrupted ? 'FAIL' : 'PASS';
  const partial = selected.size < STEPS.length ? ' (partial run: not a release run)' : '';
  console.log(
    `${'total'.padEnd(6)} ${''.padEnd(width)} ${seconds(total).padStart(9)}  ${overall}${partial}`,
  );
  if (interrupted) say('interrupted (Ctrl-C)');
  return overall === 'PASS' ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
