import { SerializeAddon } from '@xterm/addon-serialize';
import { describe, expect, it } from 'vitest';
import {
  bytes,
  diff,
  feed,
  loadRecordedScenarios,
  newEmulator,
  prng,
  probe,
  randomChunks,
  restore,
  type Scenario,
  splitStats,
} from './harness.ts';
import { syntheticScenarios } from './scenarios.ts';

const recorded = loadRecordedScenarios();
const scenarios: Scenario[] = [...recorded, ...syntheticScenarios];
/** Random chunkings per scenario: two for the real recordings, one for the synthetic streams. */
const seedsFor = (sc: Scenario) => (sc.name.startsWith('recorded:') ? [1, 2] : [1]);

describe('golden snapshot fidelity (ADR-0001)', () => {
  it('has the real recordings', () => {
    expect(recorded.map((s) => s.name)).toEqual([
      'recorded:bash',
      'recorded:htop',
      'recorded:less',
      'recorded:vim',
    ]);
  });

  it.each(scenarios)(
    '$name: chunked replay and restored snapshot match the live state',
    async (sc) => {
      const reference = newEmulator(sc.cols, sc.rows);
      feed(reference, sc);
      await reference.flush();
      // Two live emulators fed the same bytes must match exactly (no normalization).
      const expected = probe(reference, true);

      for (const seed of seedsFor(sc)) {
        const live = newEmulator(sc.cols, sc.rows);
        feed(live, sc, prng(seed));
        const snapshot = await live.snapshot();
        expect(diff(expected, probe(live, true)), `random chunks (seed ${seed})`).toEqual([]);
        const actual = probe(live);

        const restored = await restore(snapshot, live.cols, live.rows);
        expect(diff(actual, probe(restored)), `restored (seed ${seed}) vs live`).toEqual([]);
      }
    },
  );

  it('random chunking splits inside UTF-8 and escape sequences', () => {
    const stats = { insideUtf8: 0, insideEscape: 0 };
    for (const sc of scenarios) {
      for (const ev of sc.events) {
        if (typeof ev === 'object' && 'resize' in ev) continue;
        const s = splitStats(randomChunks(typeof ev === 'string' ? bytes(ev) : ev, prng(1)));
        stats.insideUtf8 += s.insideUtf8;
        stats.insideEscape += s.insideEscape;
      }
    }
    expect(stats.insideUtf8).toBeGreaterThan(20);
    expect(stats.insideEscape).toBeGreaterThan(20);
  });

  it('SerializeAddon alone loses mouse encoding and cursor style (the epilogue is required)', async () => {
    const sc = syntheticScenarios.find((s) => s.name === 'synthetic:mouse-cursor')!;
    const live = newEmulator(sc.cols, sc.rows);
    feed(live, sc);
    await live.flush();
    const plain = new SerializeAddon();
    live.terminal.loadAddon(plain);
    const restored = await restore(bytes(plain.serialize()), live.cols, live.rows);
    const mismatches = diff(probe(live), probe(restored));
    expect(mismatches).toEqual(
      expect.arrayContaining([
        '.internals.mouseEncoding: "SGR" != "DEFAULT"',
        '.internals.decPrivateModes.cursorStyle: "bar" != undefined',
      ]),
    );
  });
});
