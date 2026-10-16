// T1, spike S4: flow control (core tmux images; TD_TMUX_IMAGES to override).
// The runtime stops reading the control channel during an endless `yes` (pauseOutput):
//  - alone on the session, tmux stops reading the pane (yes blocks): nothing is lost and the
//    daemon reads nothing while paused; a %pause may still come if tmux holds blocks older than
//    pause-after when it writes again (observed on 3.2a);
//  - with a second client keeping the pane busy, tmux pauses our pane (%pause) and discards its
//    output; the driver sends continue + a snapshot batch on one line and rebuilds.
// Either way the driver's state must end equal to tmux's and memory stays bounded. The logged
// rebuilds run with a ~5k-line history (timings for ADR-0003). TD_S4_PAUSE_MS overrides the
// pause length.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TmuxControlDriver } from '../../src/drivers/tmux-control/index.ts';
import { requireSshd, sshdTransport } from '../ssh/sshd.ts';
import { compareEmulators, unknownModesFor } from './compare.ts';
import {
  DIMS,
  drainClient,
  driverOptions,
  killServerQuietly,
  memoryMiB,
  newSocket,
  referenceFromTmux,
  StubRuntime,
  selectedImages,
  sleep,
  type TmuxEnv,
  TrackingTransport,
  tmuxEnv,
  waitUntil,
} from './driver-harness.ts';

const IMAGES = selectedImages(['tmux-3.2a', 'tmux-edge']);
/** Alone, tmux simply stops the pane; with a busy second client, %pause needs the age to pass
 * pause-after while tmux still has blocks to write (3.8 sometimes needed more than 2 s). */
const PAUSE_MS = { alone: 2_000, busy: 3_500 };
if (process.env.TD_S4_PAUSE_MS) PAUSE_MS.alone = PAUSE_MS.busy = Number(process.env.TD_S4_PAUSE_MS);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const YES = `yes "$(printf 'S4 \\303\\251\\344\\270\\255 \\033[0m')"\r`;

beforeAll(() => requireSshd(IMAGES));

describe.each(IMAGES)('S4 flow control (%s)', (image) => {
  let env: TmuxEnv;
  const sockets: string[] = [];

  beforeAll(async () => {
    env = await tmuxEnv(image);
  });

  afterAll(async () => {
    for (const socket of sockets) await killServerQuietly(env, socket);
    await env.transport.close();
  });

  it('paused channel: alone the pane stops; with a busy second client %pause → continue + rebuild', async () => {
    const socket = newSocket();
    sockets.push(socket);
    const transport = new TrackingTransport(sshdTransport(image));
    await transport.connect(AbortSignal.timeout(15_000));
    let drain: { close(): Promise<void> } | null = null;
    try {
      const runtime = new StubRuntime(transport);
      const driver = new TmuxControlDriver(driverOptions(env, socket, { pauseAfterSeconds: 1 }));
      runtime.driver = driver;
      await driver.start(runtime, DIMS);
      await runtime.quiet(300);
      driver.input(enc(YES));
      await waitUntil(() => runtime.outputBytes > 1_000_000, 20_000, 'the flood');

      /** Holds the channel for `ms`, sampling memory and what queues locally. */
      const pause = async (ms: number) => {
        const before = memoryMiB();
        const received = driver.stats.receivedBytes;
        const rebuilds = driver.stats.rebuilds;
        let peak = before;
        let queued = 0;
        runtime.hold();
        for (let t = 0; t < ms; t += 250) {
          await sleep(250);
          const m = memoryMiB();
          if (m.rss > peak.rss) peak = m;
          queued = Math.max(queued, transport.queuedStdout);
        }
        const arrived = driver.stats.receivedBytes - received + queued;
        runtime.release();
        return { before, peak, queued, arrived, received, rebuilds, resumedAt: performance.now() };
      };
      const report = (label: string, p: Awaited<ReturnType<typeof pause>>, until: string) => {
        const stats = driver.stats;
        const rebuilt = stats.rebuilds > p.rebuilds;
        console.log(
          `[S4 ${image}] ${label}: ${p.arrived} B arrived while paused (queued ${p.queued} B); rss ` +
            `${p.before.rss}→${p.peak.rss} MiB; %pause total ${stats.pauses}, rebuilds +` +
            `${stats.rebuilds - p.rebuilds} (${(performance.now() - p.resumedAt).toFixed(0)} ms to ${until}` +
            `${rebuilt ? `; capture ${stats.lastRebuild?.captureMs.toFixed(0)} ms, build ${stats.lastRebuild?.buildMs.toFixed(0)} ms, history ${stats.lastRebuild?.historyLines}` : ''})`,
        );
        // Bounded: at most the channel's local queue (4 MiB) plus one SSH window arrive while paused.
        expect(p.arrived).toBeLessThan(8 * 1024 * 1024);
        expect(p.peak.rss - p.before.rss).toBeLessThan(64);
      };

      // Alone: tmux stops reading the pane (yes blocks), nothing is lost, the flow resumes.
      const alone = await pause(PAUSE_MS.alone);
      await waitUntil(
        () => driver.stats.receivedBytes > alone.received + 1_000_000,
        20_000,
        'flow',
      );
      report(`alone, paused ${PAUSE_MS.alone} ms`, alone, 'flowing');

      // A second client keeps the pane busy: tmux pauses our pane after pause-after.
      drain = await drainClient(env, socket);
      const pausesBefore = driver.stats.pauses;
      const busy = await pause(PAUSE_MS.busy);
      await waitUntil(
        () => driver.stats.pauses > pausesBefore && driver.stats.rebuilds > busy.rebuilds,
        20_000,
        '%pause → continue + rebuild',
      );
      report(`busy second client, paused ${PAUSE_MS.busy} ms`, busy, 'rebuilt');

      driver.input(enc('\x03')); // ^C stops yes
      await runtime.quiet(500);
      const reference = await referenceFromTmux(env, socket);
      const result = compareEmulators(
        reference,
        runtime.emulator,
        unknownModesFor(env.probe.tmuxVersion!),
      );
      console.log(
        `[S4 ${image}] after both pauses: max %extended-output age ${driver.stats.maxOutputAgeMs} ms; ` +
          `diffs vs tmux ${result.diffs.length}`,
      );
      expect(runtime.desyncs).toEqual([]);
      expect(result.diffs).toEqual([]);
      await driver.terminate();
    } finally {
      await drain?.close();
      await transport.close();
    }
  });
});
