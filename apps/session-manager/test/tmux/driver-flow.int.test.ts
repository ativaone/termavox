// T1, spike S4: flow control (core tmux images; TV_TMUX_IMAGES to override).
// The runtime stops reading the control channel during a `yes` flood (pauseOutput):
//  - alone on the session, tmux stops reading the pane (the flood blocks): nothing is lost and the
//    daemon reads nothing while paused; a %pause may still come if tmux holds blocks older than
//    pause-after when it writes again (observed on 3.2a);
//  - with a second client keeping the pane busy, tmux pauses our pane (%pause) and discards its
//    output; the driver sends continue + a snapshot batch on one line and rebuilds.
// Either way the driver's state must end equal to tmux's and memory stays bounded. The logged
// rebuilds run with a ~5k-line history (timings for ADR-0003). TV_S4_PAUSE_MS overrides the
// pause length.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remoteCommand, TmuxControlDriver } from '../../src/drivers/tmux-control/index.ts';
import { requireSshd, sshdTransport } from '../ssh/sshd.ts';
import { compareEmulators, unknownModesFor } from './compare.ts';
import {
  DIMS,
  drainClient,
  driverOptions,
  execBytes,
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
 * pause-after while tmux still has blocks to write (3.8 sometimes needed more than 2 s, and a
 * loaded machine more than one busy hold). */
const PAUSE_MS = { alone: 2_000, busy: 3_500 };
if (process.env.TV_S4_PAUSE_MS) PAUSE_MS.alone = PAUSE_MS.busy = Number(process.env.TV_S4_PAUSE_MS);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/**
 * The flood: `yes` of a UTF-8 line (é中 + SGR reset) in batches of whole lines until `stopFlag`
 * exists, then a marker line. Never stopped with ^C: the tty then discards the output tmux has not
 * read yet, so the stream can end inside a character, which tmux 3.8 draws as U+FFFD while xterm
 * drops it (a diff that depends only on timing).
 */
const flood = (stopFlag: string): string =>
  `l="$(printf 'S4 \\303\\251\\344\\270\\255 \\033[0m')"; ` +
  `until [ -e ${stopFlag} ]; do yes "$l" | head -n 20000; done; echo S4-stopped-$((6*7))\r`;

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
    const stopFlag = `/tmp/${socket}.stop`;
    const transport = new TrackingTransport(sshdTransport(image));
    await transport.connect(AbortSignal.timeout(15_000));
    let drain: { close(): Promise<void> } | null = null;
    try {
      const runtime = new StubRuntime(transport);
      const driver = new TmuxControlDriver(driverOptions(env, socket, { pauseAfterSeconds: 1 }));
      runtime.driver = driver;
      await driver.start(runtime, DIMS);
      await runtime.quiet(300);
      driver.input(enc(flood(stopFlag)));
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

      // Alone: tmux stops reading the pane (the flood blocks), nothing is lost, the flow resumes.
      const alone = await pause(PAUSE_MS.alone);
      await waitUntil(
        () => driver.stats.receivedBytes > alone.received + 1_000_000,
        20_000,
        'flow',
      );
      report(`alone, paused ${PAUSE_MS.alone} ms`, alone, 'flowing');

      // A second client keeps the pane busy: tmux pauses our pane once the oldest block queued for
      // it is older than pause-after. Blocks only age once the path to the daemon is full, which
      // can outlast one hold on a loaded machine: a hold without %pause is repeated (at most 3).
      drain = await drainClient(env, socket);
      const pausesBefore = driver.stats.pauses;
      const rebuildsBefore = driver.stats.rebuilds;
      const paused = (): boolean => driver.stats.pauses > pausesBefore;
      for (let hold = 1; ; hold++) {
        const busy = await pause(PAUSE_MS.busy);
        // A %pause sent during the hold arrives behind the backlog (an SSH window, tmux buffers).
        await waitUntil(
          () => paused() || driver.stats.receivedBytes > busy.received + 8 * 1024 * 1024,
          20_000,
          '%pause or the flow',
        );
        const label = `busy second client, paused ${PAUSE_MS.busy} ms (hold ${hold})`;
        if (paused()) {
          await waitUntil(
            () => driver.stats.rebuilds > rebuildsBefore,
            20_000,
            'continue + rebuild',
          );
          report(label, busy, 'rebuilt');
          break;
        }
        report(`${label}, no %pause`, busy, 'flowing');
        if (hold === 3) throw new Error('no %pause after 3 holds with a busy second client');
      }

      // The flood ends after a whole batch; the marker proves the driver applied all of it.
      await execBytes(env.transport, remoteCommand(`touch ${stopFlag}`));
      await waitUntil(() => /^S4-stopped-42$/m.test(runtime.text()), 20_000, 'the flood to stop');
      await runtime.quiet(500);
      const reference = await referenceFromTmux(env, socket);
      const result = compareEmulators(
        runtime.emulator,
        reference,
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
