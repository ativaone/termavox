// Spike S3 fixture recorder: `node apps/session-manager/test/tmux/record-rebuild-fixtures.ts [image…]`.
// Drives one real tmux control-mode session per image through the rebuild scenarios, sends the
// driver's snapshot batch after each one, and writes the raw stdout (gzip) plus the command
// lines with their stdout offsets to test/fixtures/tmux/<image>/rebuild.{bin.gz,json}.
// Requires: docker compose -f test/sshd/compose.yaml up -d --build
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { randomToken } from '@termdock/shared';
import {
  type LaunchOptions,
  launchCommand,
  snapshotCommands,
} from '../../src/drivers/tmux-control/index.ts';
import { parseProbeOutput, probeCommand } from '../../src/probe/index.ts';
import { runExec, type SshdImage, sshdTransport } from '../ssh/sshd.ts';
import { TestControlClient } from './control-client.ts';
import {
  outputBetween,
  REBUILD_FIXTURE_DIR,
  REBUILD_IMAGES,
  type RebuildFixtureMeta,
  replayRebuildTranscript,
} from './rebuild-replay.ts';

interface Scenario {
  name: string;
  /** Typed into the shell, followed by Enter. */
  command: string;
  /** When to send the snapshot batch: after `idle` ms without output, or after `bytes` of output. */
  capture: { idle: number } | { bytes: number };
  /** Typed after the capture (Enter ends a `read`). */
  after?: string;
  /** Output that marks the end of the scenario (waited for before the next one starts). */
  done?: string;
  static: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'colors+history+wrapped',
    command:
      "for i in $(seq 1 30); do printf '\\033[3%dm%03d\\033[0m \\033[1;4mbold-ul\\033[0m " +
      '\\033[38;5;208mx256\\033[0m \\033[38;5;3mlow256\\033[0m \\033[38;2;10;200;30mtrue\\033[0m ' +
      '\\033[7minv\\033[27m \\033[2mdim\\033[22m \\033[3mit\\033[23m \\033[9mst\\033[29m ' +
      '\\033[41mbg\\033[0m \\033[4:3mcurly\\033[4:0m \\033[53mover\\033[55m ' +
      "\\303\\251\\344\\270\\255\\360\\237\\230\\200\\n' $((i % 8)) $i; done; " +
      "printf '%0150d\\n' 1; printf 'wrap-\\033[44m%0100d\\033[0m-end\\n' 2",
    capture: { idle: 400 },
    static: true,
  },
  {
    name: 'alternate screen: scroll region, cursor mid-screen, modes',
    command:
      "printf '\\033[?1049h\\033[H\\033[2J\\033[1mtitle bar\\033[0m\\033[3;20r\\033[5;10H" +
      '\\033[1;33mmid\\033[0m\\033[?1h\\033=\\033[?1002h\\033[?1006h\\033[?25l\\033]2;alt-app\\007' +
      "\\033[12;4H'; read _; printf '\\033[?1049l\\033[r\\033[?1l\\033>\\033[?1002l\\033[?1006l" +
      "\\033[?25h'",
    capture: { idle: 400 },
    after: '\r',
    static: true,
  },
  {
    name: 'origin mode, scroll region, tab stops, insert mode, cursor style, focus',
    command:
      "printf '\\033[3g\\033[1;5H\\033H\\033[1;13H\\033H\\033[1;30H\\033H\\033[5;15r\\033[?6h" +
      "\\033[3;7Horigin\\033[4h\\033[?25l\\033[5 q\\033[?1004h'; read _; " +
      "printf '\\033[?6l\\033[r\\033[4l\\033[?25h\\033[0 q\\033[?1004l'",
    capture: { idle: 400 },
    after: '\r',
    static: true,
  },
  {
    name: 'wide characters at the edge, emoji, combining marks',
    command:
      "printf '%079d\\344\\270\\255\\n' 0; printf 'x\\360\\237\\230\\200%.0s' $(seq 1 40); echo; " +
      "printf 'e\\314\\201 combining, \\344\\270\\255\\346\\226\\207 cjk\\n'",
    capture: { idle: 400 },
    static: true,
  },
  {
    name: 'pending wrap',
    command: "printf '%080d' 0; sleep 1.5; printf 'X\\n'",
    capture: { idle: 300 },
    done: 'X\r\n',
    static: false,
  },
  {
    name: 'flood (capture mid-output)',
    command:
      'for i in $(seq 1 15); do seq $((i*100-99)) $((i*100)) | ' +
      'awk \'{printf "%d \\303\\251\\344\\270\\255\\360\\237\\230\\200 \\033[0m\\n", $1}\'; ' +
      'sleep 0.02; done',
    capture: { bytes: 8000 },
    static: false,
  },
];

const COLS = 80;
const ROWS = 24;
const HISTORY_LIMIT = 60;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function record(image: SshdImage): Promise<{ meta: RebuildFixtureMeta; bin: Uint8Array }> {
  const transport = sshdTransport(image);
  await transport.connect(AbortSignal.timeout(15_000));
  try {
    const probe = parseProbeOutput((await runExec(transport, probeCommand())).stdout);
    if (!probe.tmuxPath || !probe.utf8Locale) throw new Error(`${image}: no tmux/locale`);
    const opts: LaunchOptions = {
      tmuxPath: probe.tmuxPath,
      socket: `td-fixture-${randomToken(8)}`,
      locale: probe.utf8Locale,
      historyLimit: HISTORY_LIMIT,
      defaultTerminal: probe.tiTmux256 ? 'tmux-256color' : 'screen-256color',
      cols: COLS,
      rows: ROWS,
    };
    const client = new TestControlClient(await transport.exec(launchCommand(opts)));
    await client.waitFor((e) => e.type === 'output'); // the prompt
    await client.waitIdle(400);
    const starts: number[] = [];
    for (const scenario of SCENARIOS) {
      const start = client.bytesReceived;
      starts.push(start);
      const outputBefore = client.outputText(0).length;
      await client.input(0, `${scenario.command}\r`);
      if ('idle' in scenario.capture) {
        await client.waitIdle(scenario.capture.idle);
      } else {
        const target = start + scenario.capture.bytes;
        while (client.bytesReceived < target) await new Promise((r) => setImmediate(r));
      }
      const result = await client.sendBatch(snapshotCommands(0));
      if (!result.ok) throw new Error(`${image}: snapshot batch failed (${scenario.name})`);
      if (scenario.after) {
        await client.waitIdle(300);
        await client.input(0, scenario.after);
      }
      const done = scenario.done;
      if (done) {
        while (!client.outputText(0).slice(outputBefore).includes(done)) await sleep(20);
      }
      await client.waitIdle(scenario.static ? 400 : 800);
    }
    client.detach();
    await client.exit;
    await runExec(transport, `exec sh -c '${opts.tmuxPath} -L ${opts.socket} kill-server; true'`);
    return {
      meta: {
        image,
        tmuxVersion: probe.tmuxVersionRaw ?? 'unknown',
        recordedAt: new Date().toISOString().slice(0, 10),
        description:
          'One control-mode session (80x24, history-limit 60). After each scenario the driver ' +
          "snapshot batch (snapshotCommands(0) + sentinel) is sent; the flood's batch is sent " +
          'while output is still arriving.',
        cols: COLS,
        rows: ROWS,
        historyLimit: HISTORY_LIMIT,
        scenarios: SCENARIOS.map((s, i) => ({
          name: s.name,
          static: s.static,
          startAtByte: starts[i]!,
        })),
        sent: client.sent.map((s) => ({ atByte: s.atByte, line: s.line })),
      },
      bin: client.raw(),
    };
  } finally {
    await transport.close();
  }
}

const selected = process.argv.slice(2) as SshdImage[];
for (const image of selected.length > 0 ? selected : [...REBUILD_IMAGES]) {
  for (let attempt = 1; ; attempt++) {
    const { meta, bin } = await record(image);
    // The flood batch must have pane output both before its %begin and after its %end.
    const replay = await replayRebuildTranscript(meta, bin);
    const flood = replay.batches.at(-1)!;
    const before = outputBetween(replay.events, flood.issueIndex, flood.beginIndex);
    const after = outputBetween(replay.events, flood.endIndex, replay.events.length);
    console.log(`${image} attempt ${attempt}: flood output before=${before} after=${after}`);
    if ((before === 0 || after === 0) && attempt < 5) continue;
    const dir = `${REBUILD_FIXTURE_DIR}${image}/`;
    mkdirSync(dir, { recursive: true });
    const gz = gzipSync(bin, { level: 9 });
    writeFileSync(`${dir}rebuild.bin.gz`, gz);
    writeFileSync(`${dir}rebuild.json`, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`  ${bin.byteLength} bytes (${gz.byteLength} gzipped), ${meta.sent.length} lines`);
    await sleep(100);
    break;
  }
}
