// T1, spike S3: the snapshot boundary under heavy output (core tmux images; TV_TMUX_IMAGES to
// override). The pane's raw output is piped to a file from its first byte; the driver attaches
// mid-flood on its own transport, rebuilds from a capture and applies the later output. Once the
// flood is over, its emulator must equal, cell by cell, a fresh emulator fed the whole stream.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TmuxControlDriver } from '../../src/drivers/tmux-control/index.ts';
import { requireSshd, sshdTransport } from '../ssh/sshd.ts';
import { compareEmulators, unknownModesFor } from './compare.ts';
import {
  DIMS,
  driverOptions,
  killServerQuietly,
  newSocket,
  observedSession,
  referenceFromPipe,
  StubRuntime,
  selectedImages,
  type TmuxEnv,
  tmuxEnv,
  waitUntil,
} from './driver-harness.ts';

const IMAGES = selectedImages(['tmux-3.2a', 'tmux-edge']);
/** UTF-8 of é中😀: 2-, 3- and 4-byte characters a capture boundary can split. */
const UTF8 = '\\303\\251\\344\\270\\255\\360\\237\\230\\200';
const FLOODS: Array<[string, string]> = [
  [
    'seq 1 300000 (awk: UTF-8 + SGR reset per line)',
    `seq 1 300000 | awk '{printf "%d ${UTF8} \\033[0m\\n", $1}'`,
  ],
  [
    'yes in bursts with sleeps',
    `for i in 1 2 3 4; do yes "$(printf 'y ${UTF8} \\033[0m')" | head -n 15000; ` +
      'sleep 0.25; done',
  ],
];

beforeAll(() => requireSshd(IMAGES));

describe.each(IMAGES)('S3 snapshot boundary under heavy output (%s)', (image) => {
  let env: TmuxEnv;
  const sockets: string[] = [];

  beforeAll(async () => {
    env = await tmuxEnv(image);
  });

  afterAll(async () => {
    for (const socket of sockets) await killServerQuietly(env, socket);
    await env.transport.close();
  });

  it.each(FLOODS)('%s: rebuilt mid-flood + later output = live stream', async (_name, command) => {
    const socket = newSocket();
    sockets.push(socket);
    const { observer, rawPath } = await observedSession(env, socket);
    const transport = sshdTransport(image);
    await transport.connect(AbortSignal.timeout(15_000));
    try {
      const startBytes = observer.bytesReceived;
      await observer.input(0, `${command}\r`);
      await waitUntil(() => observer.bytesReceived - startBytes > 300_000, 20_000, 'the flood');

      const runtime = new StubRuntime(transport);
      const driver = new TmuxControlDriver(driverOptions(env, socket));
      runtime.driver = driver;
      await driver.start(runtime, DIMS);
      const attach = driver.stats;
      await observer.exit; // detached as a stale control client
      const forwardedAtAttach = runtime.outputBytes;
      await runtime.quiet(700, 60_000);

      const reference = await referenceFromPipe(env, socket, rawPath);
      const result = compareEmulators(
        reference.emulator,
        runtime.emulator,
        unknownModesFor(env.probe.tmuxVersion!),
      );
      console.log(
        `[S3 ${image}] ${_name}: stream ${reference.bytes} B; at attach dropped ` +
          `${attach.droppedBytes} B, held ${attach.heldBytes} B; forwarded after the rebuild ` +
          `${runtime.outputBytes - forwardedAtAttach + attach.heldBytes} B; capture ` +
          `${attach.lastRebuild?.captureMs.toFixed(0)} ms, build ${attach.lastRebuild?.buildMs.toFixed(0)} ms, ` +
          `history ${attach.lastRebuild?.historyLines} lines; scrollback compared ` +
          `${result.scrollbackCompared} (live ${result.liveScrollback}, rebuilt ${result.rebuiltScrollback}); ` +
          `diffs ${result.diffs.length}, wrap ${result.wrapDiffs.length}, violations ${driver.stats.boundaryViolations}`,
      );
      expect(result.diffs).toEqual([]);
      expect(result.wrapDiffs).toEqual([]);
      expect(result.scrollbackCompared).toBeGreaterThan(1_000);
      // Captured mid-flood: the stream kept coming after the batch's %end (applied after the
      // rebuild); the continuous flood also reached the driver before its %begin (contained in
      // the capture, dropped). The bursty one may be captured in a gap between bursts.
      expect(runtime.outputBytes - forwardedAtAttach + attach.heldBytes).toBeGreaterThan(100_000);
      if (_name.startsWith('seq')) expect(attach.droppedBytes).toBeGreaterThan(0);
      expect(driver.stats.boundaryViolations).toBe(0);
      expect(runtime.desyncs).toEqual([]);
      await driver.terminate();
    } finally {
      await transport.close();
    }
  });
});
