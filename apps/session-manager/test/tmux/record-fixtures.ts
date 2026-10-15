// Spike S2 fixture recorder: `node apps/session-manager/test/tmux/record-fixtures.ts [image…]`.
// Drives real tmux control-mode sessions on the test sshd containers and writes the raw stdout
// bytes (.bin) plus the commands sent and chunk timing (.json) to test/fixtures/tmux/<image>/.
// Requires: docker compose -f test/sshd/compose.yaml up -d --build
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomToken } from '@termdock/shared';
import {
  detachClient,
  hasSessionCommand,
  type LaunchOptions,
  launchCommand,
  listClients,
  parseListedClient,
  refreshClientContinue,
  refreshClientPauseAfter,
  refreshClientSize,
} from '../../src/drivers/tmux-control/index.ts';
import { parseProbeOutput, probeCommand } from '../../src/probe/index.ts';
import type { SshTransport } from '../../src/transport/ssh/index.ts';
import { runExec, type SshdImage, sshdTransport } from '../ssh/sshd.ts';
import { decodeLines, TestControlClient } from './control-client.ts';

const IMAGES: SshdImage[] = ['tmux-3.2a', 'tmux-3.4', 'tmux-edge'];
const OUT_DIR = fileURLToPath(new URL('../fixtures/tmux/', import.meta.url));

interface Fixture {
  image: string;
  tmuxVersion: string | null;
  recordedAt: string;
  description: string;
  launch: string;
  cols: number;
  rows: number;
  /** Command lines written to the control client, with the stdout byte offset at send time. */
  sent: Array<{ atMs: number; atByte: number; line: string }>;
  /** Other steps (input, separate exec commands) for context. */
  notes: Array<{ atMs: number; atByte: number; note: string; result?: unknown }>;
  /** stdout chunk boundaries as received: [atMs, byteLength]. */
  chunks: Array<[number, number]>;
  exit: { code: number | null; signal: string | null };
  stderr: string;
}

/** JSON-friendly view of command results: reply lines as UTF-8 text. */
function summarize(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(summarize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v)]));
  }
  return value;
}

function save(image: string, name: string, client: TestControlClient, fixture: Fixture): void {
  const dir = `${OUT_DIR}${image}/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.bin`, client.raw());
  writeFileSync(`${dir}${name}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`  ${name}: ${client.bytesReceived} bytes, ${client.sent.length} lines sent`);
}

function baseFixture(
  image: string,
  version: string | null,
  description: string,
  launch: string,
  opts: LaunchOptions,
): Omit<Fixture, 'sent' | 'chunks' | 'exit' | 'stderr'> {
  return {
    image,
    tmuxVersion: version,
    recordedAt: new Date().toISOString().slice(0, 10),
    description,
    launch,
    cols: opts.cols,
    rows: opts.rows,
    notes: [],
  };
}

async function launch(transport: SshTransport, opts: LaunchOptions): Promise<TestControlClient> {
  return new TestControlClient(await transport.exec(launchCommand(opts)));
}

/** Main transcript: launch, output, commands, resize, batches, pause/continue, kill-server. */
async function recordSession(
  image: SshdImage,
  transport: SshTransport,
  opts: LaunchOptions,
  version: string | null,
): Promise<void> {
  const fixture = baseFixture(
    image,
    version,
    'launch (flags=0 blocks) → UTF-8/wide/control output → ok/error/parse-error commands → ' +
      'refresh-client -C → batches (ok and failing) → pause-after, manual pause/continue → ' +
      'has-session → kill-server → %exit',
    launchCommand(opts),
    opts,
  );
  const client = await launch(transport, opts);
  const note = (text: string, result?: unknown): void => {
    fixture.notes.push({
      atMs: client.elapsed(),
      atByte: client.bytesReceived,
      note: text,
      result: summarize(result),
    });
  };
  await client.waitFor((e) => e.type === 'output');
  await client.waitIdle(400);

  note('input: printf with UTF-8, CJK (wide), emoji, SGR, BEL, TAB, backslash');
  await client.input(
    0,
    "printf 'caf\\303\\251 \\344\\270\\255\\346\\226\\207 \\360\\237\\230\\200 \\033[1mB\\033[0m \\\\ \\a|\\t|\\n'\r",
  );
  await client.waitIdle(400);
  note('input: UTF-8 typed directly (echo)');
  await client.input(0, 'echo é中😀\r');
  await client.waitIdle(400);

  note(
    'successful command',
    await client.send("display-message -p 'ok #{pane_id} #{pane_width}x#{pane_height}'"),
  );
  note('failing command', await client.send('select-pane -t %99'));
  note('reply line that looks like a guard', await client.send("display-message -p '%%end 1 2 1'"));
  note('parse error', await client.send('no-such-command'));
  note('pipelined: three commands written before any reply');
  const pipelined = await Promise.all([
    client.send('display-message -p one'),
    client.send('display-message -p two'),
    client.send('display-message -p three'),
  ]);
  note('pipelined results', pipelined);

  note('resize', await client.send(refreshClientSize(100, 30)));
  await client.waitFor((e) => e.type === 'layoutChange');
  await client.waitIdle(400);

  const snapshot = await client.sendBatch([
    'capture-pane -p -e -J -N -t %0 -S - -E -',
    'capture-pane -p -e -J -N -a -q -t %0',
    "display-message -p -t %0 '#{pane_id}\t#{pane_width}\t#{pane_height}\t#{history_size}\t#{cursor_x}\t#{cursor_y}\t#{alternate_on}'",
    'capture-pane -p -P -C -t %0',
  ]);
  note('snapshot batch (sentinel ok)', { ok: snapshot.ok, blocks: snapshot.blocks.length });
  const failing = await client.sendBatch([
    'display-message -p before',
    'select-pane -t %99',
    'display-message -p never-runs',
  ]);
  note('batch with a failing middle command', {
    ok: failing.ok,
    blocks: failing.blocks.map((b) => ({ ok: b.ok, text: decodeLines(b.lines) })),
  });

  note('pause-after', await client.send(refreshClientPauseAfter(2)));
  note('manual pause', await client.send("refresh-client -A '%0:pause'"));
  await client.input(0, 'echo paused\r');
  await new Promise((r) => setTimeout(r, 300));
  note('continue', await client.send(refreshClientContinue(0)));
  await client.waitIdle(400);
  await client.input(0, 'echo after\r');
  await client.waitIdle(400);
  note('message (display-message without -p)', await client.send("display-message 'msg-text'"));
  note('list-clients', await client.send(listClients()));

  note(
    'has-session (separate exec) while alive',
    (await runExec(transport, hasSessionCommand(opts))).exit,
  );
  note('kill-server', await client.send('kill-server'));
  const exit = await client.exit;
  const after = await runExec(transport, hasSessionCommand(opts));
  note('has-session (separate exec) after kill-server', {
    exit: after.exit,
    stderr: after.stderr.trim(),
  });
  save(image, 'session', client, {
    ...fixture,
    sent: client.sent,
    chunks: client.chunks.map((c) => [c.atMs, c.data.byteLength]),
    exit,
    stderr: client.stderr,
  });
}

/** Second transcript: attaching to an existing session, stale-client detach, shell exit. */
async function recordAttach(
  image: SshdImage,
  transport: SshTransport,
  opts: LaunchOptions,
  version: string | null,
): Promise<void> {
  const first = await launch(transport, opts);
  await first.waitFor((e) => e.type === 'output');
  await first.waitIdle(300);
  const fixture = baseFixture(
    image,
    version,
    'second control client attaches to an existing session (new-session -A) → list-clients → ' +
      'detach-client of the first client → shell exit → %exit',
    launchCommand(opts),
    opts,
  );
  const second = await launch(transport, opts);
  const note = (text: string, result?: unknown): void => {
    fixture.notes.push({
      atMs: second.elapsed(),
      atByte: second.bytesReceived,
      note: text,
      result: summarize(result),
    });
  };
  await second.waitFor((e) => e.type === 'sessionChanged');
  await second.waitIdle(400);
  const clients = await second.send(listClients());
  note('list-clients', clients);
  const own = (await second.send("display-message -p '#{client_name}'")).lines;
  const ownName = decodeLines(own);
  const stale = decodeLines(clients.lines)
    .split('\n')
    .map(parseListedClient)
    .find((c) => c?.controlMode && c.name !== ownName);
  if (!stale) throw new Error('first control client not listed');
  note('detach stale client', await second.send(detachClient(stale.name)));
  note('first client exit', await first.exit);
  await second.waitIdle(300);
  note('input: exit');
  await second.input(0, 'exit\r');
  const exit = await second.exit;
  save(image, 'attach', second, {
    ...fixture,
    sent: second.sent,
    chunks: second.chunks.map((c) => [c.atMs, c.data.byteLength]),
    exit,
    stderr: second.stderr,
  });
}

const selected = process.argv.slice(2) as SshdImage[];
for (const image of selected.length > 0 ? selected : IMAGES) {
  console.log(image);
  const transport = sshdTransport(image);
  await transport.connect(AbortSignal.timeout(15_000));
  try {
    const probe = parseProbeOutput((await runExec(transport, probeCommand())).stdout);
    if (!probe.tmuxPath || !probe.utf8Locale)
      throw new Error(`${image}: probe found no tmux/locale`);
    const opts = (socket: string): LaunchOptions => ({
      tmuxPath: probe.tmuxPath!,
      socket,
      locale: probe.utf8Locale!,
      historyLimit: 2000,
      defaultTerminal: probe.tiTmux256 ? 'tmux-256color' : 'screen-256color',
      cols: 80,
      rows: 24,
      env: { TD_FIXTURE: 'yes' },
    });
    await recordSession(
      image,
      transport,
      opts(`td-fixture-${randomToken(8)}`),
      probe.tmuxVersionRaw,
    );
    await recordAttach(
      image,
      transport,
      opts(`td-fixture-${randomToken(8)}`),
      probe.tmuxVersionRaw,
    );
  } finally {
    await transport.close();
  }
}
