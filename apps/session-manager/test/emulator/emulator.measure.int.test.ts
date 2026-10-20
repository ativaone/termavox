/**
 * Spike S1 measurements (ADR-0001), T1: snapshot cost and memory at a full 10,000-line
 * scrollback, and snapshot compressibility. Prints a report; asserts only loose budgets.
 * Run: pnpm exec vitest run --project t1 apps/session-manager/test/emulator
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { DEFAULT_SCROLLBACK } from '@termavox/terminal-config';
import { SerializeAddon } from '@xterm/addon-serialize';
import { describe, expect, it } from 'vitest';
import { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';
import { bytes, feed, loadRecordedScenarios, newEmulator } from './harness.ts';

const COLS = 120;
const ROWS = 40;
const LINES = DEFAULT_SCROLLBACK + ROWS;

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

/** 120 visible columns per line, a new SGR every 8 columns (16/256/truecolor and flags). */
function mixedSgrLine(i: number): string {
  const sgr = [
    (k: number) => `\x1b[${30 + (k % 8)}m`,
    (k: number) => `\x1b[38;5;${k % 256};48;5;${(k * 7) % 256}m`,
    (k: number) => `\x1b[38;2;${k % 256};${(k * 3) % 256};${(k * 5) % 256}m`,
    (k: number) => `\x1b[${[1, 3, 4, 7, 2][k % 5]}m`,
    () => '\x1b[0m',
  ];
  let line = '';
  for (let seg = 0; seg < COLS / 8; seg++) {
    const k = i * 31 + seg;
    line += sgr[k % sgr.length]!(k) + `${k}`.padEnd(8, '.').slice(0, 8);
  }
  return `${line}\x1b[0m\r\n`;
}

/** Log-like output: a colored timestamp and level, plain text, ~100 columns. */
function typicalLine(i: number): string {
  const level = i % 17 === 0 ? '\x1b[31mERROR\x1b[0m' : '\x1b[36mINFO\x1b[0m ';
  const ts = `\x1b[2m2026-10-15T12:${String(i % 60).padStart(2, '0')}:00Z\x1b[0m`;
  return `${ts} ${level} request id=${(i * 7919).toString(16).padStart(8, '0')} path=/api/v1/items/${i} status=200 duration=${i % 97}ms\r\n`;
}

const fills = {
  'mixed SGR (new SGR every 8 columns)': bytes(
    Array.from({ length: LINES }, (_, i) => mixedSgrLine(i)).join(''),
  ),
  'typical log output (4 SGR runs per line)': bytes(
    Array.from({ length: LINES }, (_, i) => typicalLine(i)).join(''),
  ),
};
const fillData = fills['mixed SGR (new SGR every 8 columns)'];

async function filled(data = fillData): Promise<HeadlessEmulator> {
  const em = new HeadlessEmulator({
    cols: COLS,
    rows: ROWS,
    scrollback: DEFAULT_SCROLLBACK,
    answerQueries: true,
  });
  for (let i = 0; i < data.length; i += 64 * 1024) em.write(data.subarray(i, i + 64 * 1024));
  await em.flush();
  return em;
}

/** Median CPU time of a plain `serialize({ scrollback })` (the cost scales with lines). */
function serializeCpu(em: HeadlessEmulator, scrollback: number): number {
  const plain = new SerializeAddon();
  em.terminal.loadAddon(plain);
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const c = process.cpuUsage();
    plain.serialize({ scrollback });
    const used = process.cpuUsage(c);
    runs.push((used.user + used.system) / 1000);
  }
  plain.dispose();
  return median(runs);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

describe('S1 measurements', () => {
  it('retained memory per emulator at a full scrollback', async () => {
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        gc();
        await new Promise((r) => setImmediate(r));
      }
    };
    const n = 4;
    await settle();
    const before = process.memoryUsage();
    const ems: HeadlessEmulator[] = [];
    for (let i = 0; i < n; i++) ems.push(await filled());
    await settle();
    const after = process.memoryUsage();
    const per = (k: 'heapUsed' | 'external' | 'arrayBuffers' | 'rss') => (after[k] - before[k]) / n;
    // Cross-check: bytes of xterm's per-line cell arrays (3 × uint32 per cell).
    // biome-ignore lint/suspicious/noExplicitAny: measurement-only access to xterm internals
    const lines = (ems[0]!.terminal as any)._core.buffers.normal.lines;
    let cellBytes = 0;
    for (let i = 0; i < lines.length; i++) cellBytes += lines.get(i)._data.byteLength;
    console.log(
      `per emulator (${n} filled, after gc): heapUsed ${mib(per('heapUsed'))}, ` +
        `external ${mib(per('external'))} (arrayBuffers ${mib(per('arrayBuffers'))}), ` +
        `rss ${mib(per('rss'))}; cell arrays ${mib(cellBytes)}`,
    );
    expect(per('heapUsed') + per('external')).toBeLessThan(200 * 1024 * 1024);
    for (const em of ems) em.dispose();
  });

  it.each(Object.entries(fills))(
    'snapshot cost, size and gzip ratio at 10,000 lines: %s',
    async (_name, data) => {
      const t0 = performance.now();
      const em = await filled(data);
      const ingestMs = performance.now() - t0;
      expect(em.terminal.buffer.normal.length).toBe(LINES);

      const runs: number[] = [];
      const cpu: number[] = [];
      let snapshot: Uint8Array = new Uint8Array();
      for (let i = 0; i < 9; i++) {
        const t = performance.now();
        const c = process.cpuUsage();
        snapshot = await em.snapshot();
        const used = process.cpuUsage(c);
        runs.push(performance.now() - t);
        cpu.push((used.user + used.system) / 1000);
      }
      const tz = performance.now();
      const gz = gzipSync(snapshot);
      const gzipMs = performance.now() - tz;

      const restoreRuns: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        const client = newEmulator(COLS, ROWS);
        client.terminal.options.scrollback = DEFAULT_SCROLLBACK;
        client.write(snapshot);
        await client.flush();
        restoreRuns.push(performance.now() - t);
        client.dispose();
      }

      console.log(
        [
          `ingest: ${mib(data.length)} in ${ingestMs.toFixed(0)} ms (${(data.length / 1024 / 1024 / (ingestMs / 1000)).toFixed(1)} MiB/s)`,
          `snapshot(): median ${median(runs).toFixed(1)} ms wall, ${median(cpu).toFixed(1)} ms CPU, of ${runs.length} runs (wall min ${Math.min(...runs).toFixed(1)}, max ${Math.max(...runs).toFixed(1)})`,
          `snapshot size: ${mib(snapshot.length)}; gzip -6: ${mib(gz.length)} (ratio ${(snapshot.length / gz.length).toFixed(1)}:1, ${gzipMs.toFixed(0)} ms)`,
          `restore into a fresh terminal: median ${median(restoreRuns).toFixed(0)} ms`,
          `plain SerializeAddon CPU by scrollback: ${[0, 1_000, 5_000, DEFAULT_SCROLLBACK].map((n) => `${n} lines ${serializeCpu(em, n).toFixed(1)} ms`).join(', ')}`,
        ].join('\n'),
      );
      expect(median(runs)).toBeLessThan(2_000);
    },
  );

  it('gzip ratio of typical snapshots (recorded sessions)', async () => {
    const rows: string[] = [];
    for (const sc of loadRecordedScenarios()) {
      const em = newEmulator(sc.cols, sc.rows);
      feed(em, sc);
      const snap = await em.snapshot();
      const gz = gzipSync(snap);
      rows.push(
        `${sc.name}: ${snap.length} B -> ${gz.length} B gzip (${(snap.length / gz.length).toFixed(1)}:1)`,
      );
    }
    console.log(rows.join('\n'));
  });
});
