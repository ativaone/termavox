import { decodeFrame, FrameType } from '@termavox/protocol';
import { describe, expect, it } from 'vitest';
import {
  bytes,
  diff,
  loadRecordedScenarios,
  prng,
  probe,
  randomChunks,
} from '../emulator/harness.ts';
import { encode, FakeAttachment, harness, until } from './fakes.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function frameTypes(attachment: FakeAttachment): string[] {
  return attachment.frames.map((f) => {
    if (f[0] === 0x7b) return (JSON.parse(Buffer.from(f).toString()) as { type: string }).type;
    return decodeFrame(f).type === FrameType.Snapshot ? 'SNAPSHOT' : 'OUTPUT';
  });
}

describe('output pipeline', () => {
  it('snapshots at the barrier, then sends only later seqs; sequenced resizes keep clients equal', async () => {
    const h = harness({ record: { cols: 100, rows: 30 } });
    const rt = h.runtime();
    await rt.start();
    const pty = h.factory.last.pty;
    const a = new FakeAttachment('a');
    rt.attach(a, { cols: 100, rows: 30 });

    const scenarios = loadRecordedScenarios();
    const stream = ['bash', 'less', 'vim', 'htop'].flatMap(
      (name) => scenarios.find((s) => s.name === `recorded:${name}`)!.events,
    );
    const rand = prng(42);
    const viewports = [
      { cols: 90, rows: 26 },
      { cols: 120, rows: 35 },
      { cols: 72, rows: 20 },
    ];
    let b: FakeAttachment | null = null;
    let pushed = 0;
    for (const event of stream) {
      if (typeof event === 'object' && 'resize' in event) {
        rt.viewport('a', { cols: event.resize[0], rows: event.resize[1] });
        continue;
      }
      const data = typeof event === 'string' ? bytes(event) : event;
      for (const chunk of randomChunks(data, rand, 0.9)) {
        pty.stdout.push(chunk);
        pushed++;
        if (pushed === 400) {
          // A second attachment arrives mid-stream; more chunks follow in the same tick.
          b = new FakeAttachment('b');
          rt.attach(b, { cols: 90, rows: 26 });
        }
        if (pushed % 60 === 0) {
          const vp = viewports[(pushed / 60) % viewports.length]!;
          if (pushed % 120 === 0)
            rt.input('b', encode('x')); // b becomes active
          else rt.viewport('a', vp);
          if (pushed % 180 === 0) rt.activate('a');
          await sleep(3); // let debounced resizes land between writes
        }
      }
    }
    await until(() => pty.stdout.bufferedBytes === 0);
    await sleep(30); // last coalescing window

    const server = rt.emulator;
    await server.flush();
    for (const attachment of [a, b!]) {
      const client = await attachment.client.settle();
      expect(attachment.client.violations).toEqual([]);
      expect(diff(probe(server), probe(client))).toEqual([]);
      // Resizes travel in the stream: exactly one snapshot per attachment.
      expect(attachment.client.snapshots).toHaveLength(1);
      expect(attachment.client.resizes.length).toBeGreaterThan(2);
    }
    // The latest terminal title may come with the attach (it is not in the snapshot); no output does.
    const leading = frameTypes(b!).filter((type) => type !== 'terminal.title');
    expect(leading.slice(0, 2)).toEqual(['session.attached', 'SNAPSHOT']);
    const bSnapshot = b!.client.snapshots[0]!.seq;
    expect(bSnapshot).toBeGreaterThan(0);
    expect(b!.client.outputSeqs[0]).toBeGreaterThan(bSnapshot);
    expect(a.client.outputSeqs.at(-1)).toBe(rt.seq);
    // Coalescing: far fewer frames than chunks.
    expect(a.client.outputSeqs.length).toBeLessThan(pushed / 2);
    // Both attachments saw both active flags (b took over, then a again).
    expect(new Set(a.client.resizes.map((r) => r.active))).toEqual(new Set([true, false]));
    await rt.shutdown();
  });

  it('stops OUTPUT to a lagging attachment and resyncs it once drained', async () => {
    const h = harness();
    const rt = h.runtime();
    await rt.start();
    const pty = h.factory.last.pty;
    const a = new FakeAttachment('a');
    rt.attach(a, { cols: 80, rows: 24 });
    pty.stdout.push(encode('before\r\n'));
    await until(() => a.client.outputSeqs.length === 1);

    a.bufferedAmount = 3 * 1024 * 1024;
    pty.stdout.push(encode('\x1b[31mtrigger\r\n'));
    await sleep(30);
    const sent = a.frames.length;
    for (let i = 0; i < 50; i++) pty.stdout.push(encode(`line ${i}\r\n`));
    await sleep(30);
    expect(a.frames.length).toBe(sent);

    a.bufferedAmount = 100 * 1024;
    await until(() => a.client.snapshots.length === 2);
    pty.stdout.push(encode('after\x1b[0m\r\n'));
    await sleep(30);
    await rt.emulator.flush();
    const client = await a.client.settle();
    expect(a.client.violations).toEqual([]);
    expect(diff(probe(rt.emulator), probe(client))).toEqual([]);
    await rt.shutdown();
  });
});
