import { describe, expect, it } from 'vitest';
import type { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';
import {
  bytes,
  diff,
  loadRecordedScenarios,
  newEmulator,
  prng,
  probe,
  randomChunks,
  restore,
  type Scenario,
} from './harness.ts';

type Op = Uint8Array | { resize: [number, number] };

function ops(sc: Scenario, rand: () => number): Op[] {
  return sc.events.flatMap((ev): Op[] => {
    if (typeof ev === 'object' && 'resize' in ev) return [ev];
    return randomChunks(typeof ev === 'string' ? bytes(ev) : ev, rand, 0.2);
  });
}

function apply(em: HeadlessEmulator, list: Op[]): void {
  for (const op of list) {
    if (op instanceof Uint8Array) em.write(op);
    else em.resize({ cols: op.resize[0], rows: op.resize[1] });
  }
}

/** Snapshot at the barrier `k`, with the remaining ops submitted before the promise settles. */
async function checkBarrier(sc: Scenario, list: Op[], k: number): Promise<void> {
  const live = newEmulator(sc.cols, sc.rows);
  apply(live, list.slice(0, k));
  const size = { cols: live.cols, rows: live.rows };
  const pending = live.snapshot();
  apply(live, list.slice(k)); // same tick: parsed in the same xterm write batch
  const snapshot = await pending;

  const reference = newEmulator(sc.cols, sc.rows);
  apply(reference, list.slice(0, k));
  expect(await reference.snapshot(), `snapshot at op ${k}`).toEqual(snapshot);

  // The client applies the snapshot, then every op after the barrier.
  const client = await restore(snapshot, size.cols, size.rows);
  apply(client, list.slice(k));
  await Promise.all([client.flush(), live.flush()]);
  expect(diff(probe(live), probe(client)), `client resumed at op ${k}`).toEqual([]);
}

const ESC = '\x1b';

describe('snapshot barrier (ADR-0001)', () => {
  it('xterm runs write callbacks synchronously between chunks', async () => {
    const em = newEmulator(40, 5);
    const seen: string[] = [];
    const line = () => em.terminal.buffer.active.getLine(0)!.translateToString(true);
    em.terminal.write('a', () => seen.push(line()));
    em.terminal.write('b', () => seen.push(line()));
    em.terminal.write('c', () => seen.push(line()));
    await em.flush();
    expect(seen).toEqual(['a', 'ab', 'abc']);
  });

  it.each(loadRecordedScenarios())(
    '$name: snapshot at random barriers, client resumes identically',
    async (sc) => {
      const rand = prng(7);
      const list = ops(sc, rand);
      const barriers = Array.from({ length: 3 }, () => 1 + Math.floor(rand() * (list.length - 1)));
      for (const k of barriers) await checkBarrier(sc, list, k);
    },
  );

  // Barriers inside sequences: the screen alone cannot express a half-parsed sequence, so the
  // snapshot ends with the unfinished bytes (and an incomplete UTF-8 character).
  it.each([
    ['inside CSI parameters', [`${ESC}[1;3`, '1mred', `${ESC}[0m`]],
    ['right after ESC', [`x${ESC}`, '[?1006h', 'y']],
    ['inside an OSC title', [`${ESC}]2;half`, ' title\x07z']],
    ['inside a DCS request', [`${ESC}P$`, `qm${ESC}\\w`]],
    ['between ESC and the ST backslash', [`${ESC}]2;t\x1b`, '\\v']],
    ['inside a UTF-8 character', [bytes('a—').subarray(0, 3), bytes('—b').subarray(2)]],
    ['inside a ZWJ emoji sequence', [bytes('👨‍👩').subarray(0, 6), bytes('👨‍👩').subarray(6)]],
    ['inside a mode change the tracker observes', [`${ESC}[?100`, `6h${ESC}[6 `, 'q']],
    ['inside a CSI opened by the C1 control U+009B', [`ab${ESC}[2Cy\u009b3`, '1mred']],
    ['inside an OSC opened by U+009D after an earlier ESC', [`${ESC}[3Cz\u009d2;ti`, 'tle\u009cw']],
  ] as const)('barrier %s', async (_name, parts) => {
    const list: Op[] = parts.map((p) => (typeof p === 'string' ? bytes(p) : p));
    const sc: Scenario = { name: 'targeted', cols: 40, rows: 5, events: [] };
    for (let k = 1; k < list.length; k++) await checkBarrier(sc, list, k);
  });

  it('applies resizes through the write queue', async () => {
    const before = bytes(`${'a'.repeat(150)}\r\n${'b'.repeat(90)}\r\n${ESC}[3g${ESC}[50G${ESC}H\r`);
    const after = bytes(`${'c'.repeat(150)}\r\n\tx${ESC}[2;70Hpast the new width`);

    const queued = newEmulator(100, 30);
    queued.write(before);
    queued.resize({ cols: 60, rows: 20 });
    expect({ cols: queued.cols, rows: queued.rows }).toEqual({ cols: 60, rows: 20 });
    queued.write(after);
    await queued.flush();

    const sequential = newEmulator(100, 30);
    sequential.write(before);
    await sequential.flush();
    sequential.terminal.resize(60, 20);
    sequential.write(after);
    await sequential.flush();
    expect(diff(probe(sequential), probe(queued))).toEqual([]);

    // Control: resizing after both writes gives a different state, so the order is observable.
    const late = newEmulator(100, 30);
    late.write(before);
    late.write(after);
    await late.flush();
    late.terminal.resize(60, 20);
    expect(diff(probe(sequential), probe(late)).length).toBeGreaterThan(0);
  });

  it('answers terminal queries only when answerQueries is set', async () => {
    const replies = (answer: boolean) => {
      const em = newEmulator(40, 5, answer);
      const out: string[] = [];
      em.onReply((d) => out.push(new TextDecoder().decode(d)));
      em.write(bytes(`ab${ESC}[6n${ESC}[c`));
      return em.flush().then(() => out);
    };
    expect(await replies(true)).toEqual([`${ESC}[1;3R`, `${ESC}[?1;2c`]);
    expect(await replies(false)).toEqual([]);
  });
});
