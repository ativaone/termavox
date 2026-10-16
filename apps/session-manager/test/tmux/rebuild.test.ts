/**
 * Rebuild from RECORDED captures (record-rebuild-fixtures.ts, spike S3), no containers.
 *
 * For every snapshot batch of every transcript:
 *  - static scenarios: the emulator rebuilt from the capture equals, cell by cell, an emulator
 *    fed the pane's raw %output up to the batch;
 *  - every batch (incl. the flood captured mid-output): replaying the transcript through the
 *    boundary gate exactly like the driver (drop before the batch's %begin, hold after its %end),
 *    then rebuilding and applying the held output, ends equal to the live emulator fed all output.
 */
import { describe, expect, it } from 'vitest';
import {
  type ControlEvent,
  OutputGate,
  type PaneCapture,
  PenTracker,
  paneSizeFromLayout,
  parseCapture,
  parsePaneState,
  rebuild,
} from '../../src/drivers/tmux-control/index.ts';
import { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';
import { parseTmuxVersion } from '../../src/probe/index.ts';
import { compareEmulators, unknownModesFor } from './compare.ts';
import {
  loadRebuildFixture,
  outputBetween,
  REBUILD_IMAGES,
  type ReplayedBatch,
  replayRebuildTranscript,
} from './rebuild-replay.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function isPaneOutput(
  e: ControlEvent,
): e is Extract<ControlEvent, { type: 'output' | 'extendedOutput' }> {
  return (e.type === 'output' || e.type === 'extendedOutput') && e.paneId === 0;
}

describe.each(REBUILD_IMAGES)('rebuild from recorded captures (%s)', (image) => {
  const { meta, bin } = loadRebuildFixture(image);
  const version = parseTmuxVersion(meta.tmuxVersion)!;
  const unknown = unknownModesFor(version);
  const emulator = (): HeadlessEmulator =>
    new HeadlessEmulator({
      cols: meta.cols,
      rows: meta.rows,
      scrollback: meta.historyLimit,
      answerQueries: false,
    });
  const replayed = replayRebuildTranscript(meta, bin);

  async function liveUpTo(events: readonly ControlEvent[], end: number): Promise<HeadlessEmulator> {
    const live = emulator();
    for (let i = 0; i < end; i++) {
      const e = events[i]!;
      if (isPaneOutput(e)) live.write(e.data);
    }
    await live.flush();
    return live;
  }

  // The one documented wrap-flag difference (ADR-0003): the wide-character scenario's output
  // starts on a row that used to wrap, after an explicit LF; xterm clears the flag, tmux keeps it.
  // It shows while that row is on screen (scenario 3 until the flood scrolls it away).
  const staleWrapRows = (
    stop: number,
    events: readonly ControlEvent[],
    wideStart: number,
  ): number => (stop > wideStart && stop < events.length ? 1 : 0);

  it.each(meta.scenarios.map((s, i) => [i, s.name] as const))(
    'batch %i (%s): rebuilt + later output = live',
    async (index) => {
      const { events, batches } = await replayed;
      const batch: ReplayedBatch = batches[index]!;
      const wideStart = batches.find((b) => b.name.startsWith('wide'))!.startIndex;
      expect(batch.ok).toBe(true);
      const capture: PaneCapture = parseCapture(batch.blocks);

      if (batch.static) {
        const live = await liveUpTo(events, batch.beginIndex);
        const rebuilt = emulator();
        await rebuild(rebuilt, capture);
        const result = compareEmulators(live, rebuilt, unknown);
        expect(result.diffs).toEqual([]);
        expect(result.wrapDiffs.length).toBeLessThanOrEqual(
          staleWrapRows(batch.beginIndex, events, wideStart),
        );
      }

      // The driver's path: the gate is live before the batch is written.
      const gate = new OutputGate('live');
      const heldAt: number[] = [];
      for (let i = 0; i < events.length; i++) {
        if (i === batch.issueIndex) gate.arm();
        if (i === batch.beginIndex) gate.begin();
        if (i === batch.endIndex) gate.end();
        const e = events[i]!;
        if (isPaneOutput(e) && gate.push({ kind: 'output', data: e.data }) === 'hold') {
          heldAt.push(i);
        }
      }
      expect(gate.stats.violations).toBe(0);
      const held = gate.release();
      // Compared twice: right before the next scenario's command (nothing has scrolled away
      // yet), and at the end of the transcript.
      const nextScenario = batches[index + 1]?.startIndex ?? events.length;
      for (const stop of new Set([nextScenario, events.length])) {
        const rebuilt = emulator();
        await rebuild(rebuilt, capture, gate.carry);
        held.forEach((event, k) => {
          if (event.kind === 'output' && heldAt[k]! < stop) rebuilt.write(event.data);
        });
        await rebuilt.flush();
        const live = await liveUpTo(events, stop);
        const result = compareEmulators(live, rebuilt, unknown);
        expect(result.diffs).toEqual([]);
        expect(result.wrapDiffs.length).toBeLessThanOrEqual(staleWrapRows(stop, events, wideStart));
        expect(result.scrollbackCompared).toBeGreaterThan(0);
      }
    },
  );

  it('the flood batch was captured mid-output (dropped before %begin, held after %end)', async () => {
    const { events, batches } = await replayed;
    const flood = batches.at(-1)!;
    expect(outputBetween(events, flood.issueIndex, flood.beginIndex)).toBeGreaterThan(0);
    expect(outputBetween(events, flood.beginIndex, flood.endIndex + 1)).toBe(0);
    expect(outputBetween(events, flood.endIndex, events.length)).toBeGreaterThan(0);
  });

  it('reports the pending wrap as cursor_x == pane_width', async () => {
    const { batches } = await replayed;
    const pending = parseCapture(batches.find((b) => b.name === 'pending wrap')!.blocks);
    expect(pending.state.cursorX).toBe(pending.state.width);
  });
});

describe('rebuild units', () => {
  it('parses the pane state of old and new tmux versions', () => {
    const fields = (title: string, extra: string[]): string =>
      [
        '%3',
        '80',
        '24',
        '12',
        '5',
        '7',
        '1',
        '4294967295',
        '4294967295',
        '2',
        '19',
        '0',
        '1',
        '1',
        '0',
        '1',
        '1',
        '0',
        '1',
        '0',
        '1',
        '0',
        '0',
        '4,19',
        ...extra,
        'host',
        'host',
        title,
      ].join('\t');
    const old = parsePaneState(fields('my\\ title\\$x', ['', '', '', '']));
    expect(old).toMatchObject({
      paneId: 3,
      historySize: 12,
      altSavedX: null,
      scrollUpper: 2,
      cursorVisible: false,
      insertMode: true,
      mouseButton: true,
      tabs: [4, 19],
      bracketPaste: null,
      cursorShape: null,
      privateModes: null,
      title: 'my title$x',
    });
    const v38 = parsePaneState(fields('t', ['1', 'bar', '1', '1,7,1004']));
    expect(v38).toMatchObject({ bracketPaste: true, cursorShape: 'bar', cursorBlinking: true });
    expect([...(v38.privateModes ?? [])]).toEqual([1, 7, 1004]);
    expect(() => parsePaneState('garbage')).toThrow(/snapshot/);
  });

  it('tracks the SGR pen, shift state and hyperlinks across capture lines', () => {
    const pen = new PenTracker();
    pen.feed(enc('a\x1b[1m\x1b[38;5;208mb\x1b[4:3m\x1b[48;2;1;2;3mc\x0eq'));
    expect(pen.sgr()).toBe('\x1b[0;1;4:3;38;5;208;48;2;1;2;3m');
    expect(pen.shiftOut).toBe(true);
    pen.feed(enc('\x0f\x1b[0m\x1b[32m\x1b]8;;http://x/\x1b\\link'));
    expect(pen.restore()).toBe('\x1b[0;32m\x1b]8;;http://x/\x1b\\');
    expect(pen.close()).toBe('\x1b]8;;\x1b\\');
    pen.feed(enc('\x1b]8;;\x1b\\\x1b[39m'));
    expect(pen.isDefault()).toBe(true);
    expect(pen.close()).toBe('');
  });

  it('resumes a character or an escape sequence cut by the capture boundary', async () => {
    // A 10x3 pane showing "ab" with the cursor after it.
    const state = parsePaneState(
      [
        '%0',
        '10',
        '3',
        '0',
        '2',
        '0',
        '0',
        '',
        '',
        '0',
        '2',
        '1',
        '0',
        '0',
        '0',
        '1',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '8',
        '0',
        '',
        '',
        '',
        'h',
        'h',
        'h',
      ].join('\t'),
    );
    const capture = (pending: Uint8Array): PaneCapture => ({
      state,
      history: [],
      screen: [enc('ab'), enc(''), enc('')],
      screenRows: [enc('ab'), enc(''), enc('')],
      savedMain: null,
      wrappedIntoScreen: false,
      pending,
    });
    const row0 = async (em: HeadlessEmulator): Promise<string> => {
      await em.flush();
      return em.terminal.buffer.active.getLine(0)!.translateToString(true);
    };

    // 中 = e4 b8 ad: tmux parsed "ab" and holds e4 b8 outside its grid; the rest comes later.
    const gate = new OutputGate('live');
    gate.arm();
    expect(gate.push({ kind: 'output', data: new Uint8Array([0x61, 0x62, 0xe4, 0xb8]) })).toBe(
      'drop',
    );
    gate.begin();
    gate.end();
    expect(gate.push({ kind: 'output', data: new Uint8Array([0xad, 0x21]) })).toBe('hold');
    const em = new HeadlessEmulator({ cols: 10, rows: 3, scrollback: 10, answerQueries: false });
    await rebuild(em, capture(new Uint8Array(0)), gate.carry);
    for (const event of gate.release()) if (event.kind === 'output') em.write(event.data);
    expect(await row0(em)).toBe('ab中!');

    // An SGR sequence pending in tmux's parser (`capture-pane -P`) continues after the rebuild.
    const sgr = new HeadlessEmulator({ cols: 10, rows: 3, scrollback: 10, answerQueries: false });
    await rebuild(sgr, capture(enc('\x1b[3')), gate.carry);
    sgr.write(enc('1mX'));
    expect(await row0(sgr)).toBe('abX');
    const cell = sgr.terminal.buffer.active.getLine(0)!.getCell(2)!;
    expect(cell.isFgPalette() && cell.getFgColor()).toBe(1);
  });

  it('finds a pane size in single and split window layouts', () => {
    expect(paneSizeFromLayout('a87d,100x30,0,0,0', 0)).toEqual({ cols: 100, rows: 30 });
    const split = 'b3c1,159x48,0,0{79x48,0,0,0,79x48,80,0[79x24,80,0,1,79x23,80,25,12]}';
    expect(paneSizeFromLayout(split, 12)).toEqual({ cols: 79, rows: 23 });
    expect(paneSizeFromLayout(split, 2)).toBeNull();
  });
});
