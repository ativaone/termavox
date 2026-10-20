/**
 * Replays the control-mode transcripts recorded by record-fixtures.ts (spike S2) through the
 * splitter → parser → correlator stack, once with the original chunk boundaries and once one
 * byte at a time. No containers.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type BatchResult,
  CommandCorrelator,
  type CommandResult,
  type ControlEvent,
  ControlParser,
  LineSplitter,
  singlePaneLayout,
} from '../../src/drivers/tmux-control/index.ts';

const DIR = fileURLToPath(new URL('../fixtures/tmux/', import.meta.url));
const IMAGES = ['tmux-3.2a', 'tmux-3.4', 'tmux-edge'] as const;
const SENTINEL = / ; display-message -p '(tv-[a-z2-7]+)'$/;

interface FixtureMeta {
  tmuxVersion: string;
  sent: Array<{ atByte: number; line: string }>;
  chunks: Array<[number, number]>;
}

interface Replay {
  events: ControlEvent[];
  results: Map<string, CommandResult | BatchResult>;
  errors: unknown[];
}

function load(image: string, name: string): { meta: FixtureMeta; bin: Uint8Array } {
  return {
    meta: JSON.parse(readFileSync(`${DIR}${image}/${name}.json`, 'utf8')) as FixtureMeta,
    bin: new Uint8Array(readFileSync(`${DIR}${image}/${name}.bin`)),
  };
}

/** Re-issues every recorded command line at its recorded byte offset and feeds the bytes. */
async function replay(meta: FixtureMeta, bin: Uint8Array, chunkSizes: number[]): Promise<Replay> {
  const events: ControlEvent[] = [];
  const results = new Map<string, CommandResult | BatchResult>();
  const errors: unknown[] = [];
  const written: string[] = [];
  let nonce = '';
  const correlator = new CommandCorrelator((line) => written.push(line), { nonce: () => nonce });
  const parser = new ControlParser();
  const splitter = new LineSplitter();
  const pending: Promise<void>[] = [];
  let step = 0;
  let offset = 0;

  const issueDue = (): void => {
    while (step < meta.sent.length && meta.sent[step]!.atByte <= offset) {
      const { line } = meta.sent[step++]!;
      const sentinel = SENTINEL.exec(line);
      let promise: Promise<CommandResult | BatchResult>;
      if (sentinel) {
        nonce = sentinel[1]!;
        promise = correlator.sendBatch(line.slice(0, sentinel.index).split(' ; '));
      } else {
        promise = correlator.send(line);
      }
      pending.push(
        promise.then(
          (r) => void results.set(line, r),
          (e) => void errors.push(e),
        ),
      );
    }
  };

  for (const size of chunkSizes) {
    issueDue();
    const chunk = bin.slice(offset, offset + size);
    offset += size;
    for (const line of splitter.push(chunk)) {
      const event = parser.push(line);
      if (!event) continue;
      try {
        correlator.handle(event);
      } catch (err) {
        errors.push(err);
      }
      events.push(event);
    }
  }
  issueDue();
  expect(splitter.end()).toBeNull();
  expect(parser.inBlock).toBe(false);
  correlator.failAll(new Error('end of transcript'));
  await Promise.all(pending);
  expect(written).toEqual(meta.sent.map((s) => s.line));
  return { events, results, errors };
}

const text = (lines: readonly Uint8Array[]): string[] =>
  lines.map((l) => Buffer.from(l).toString('utf8'));

function outputOf(events: ControlEvent[]): string {
  const parts: Uint8Array[] = [];
  for (const e of events) {
    if (e.type === 'output' || e.type === 'extendedOutput') parts.push(e.data);
  }
  return Buffer.concat(parts).toString('utf8');
}

function single(r: Replay, line: string): CommandResult {
  const result = r.results.get(line);
  if (!result || !('lines' in result)) throw new Error(`no result for ${line}`);
  return result;
}

function batch(r: Replay, prefix: string): BatchResult {
  for (const [line, result] of r.results) {
    if (line.startsWith(prefix) && 'blocks' in result) return result;
  }
  throw new Error(`no batch starting with ${prefix}`);
}

describe.each(IMAGES)('recorded control-mode session (%s)', (image) => {
  const { meta, bin } = load(image, 'session');
  const variants = {
    'recorded chunks': meta.chunks.map(([, length]) => length),
    'one byte at a time': Array.from({ length: bin.byteLength }, () => 1),
  };

  it.each(Object.keys(variants))('replays with %s', async (variant) => {
    const r = await replay(meta, bin, variants[variant as keyof typeof variants]);
    expect(r.errors).toEqual([]);
    expect(r.results.size).toBe(meta.sent.length);

    // Launch: one unsolicited (flags 0) block per argv command, before any reply of ours.
    const blocks = r.events.filter((e) => e.type === 'blockEnd' || e.type === 'blockError');
    expect(blocks.slice(0, 8).every((b) => b.guard.flags === 0)).toBe(true);
    expect(blocks.slice(8).every((b) => b.guard.flags === 1)).toBe(true);
    expect(r.events).toContainEqual({ type: 'sessionChanged', sessionId: 0, name: 'main' });

    // Output: UTF-8, wide chars, emoji, SGR, BEL, TAB and a backslash survive unescaping.
    const output = outputOf(r.events);
    expect(output).toContain('café 中文 😀 \x1b[1mB\x1b[0m \\ \x07|\t|\r\n');
    expect(output).toContain('é中😀\r\n');
    expect(output).toContain('after\r\n');
    expect(output).not.toContain('paused\r\n'); // output of a paused pane is dropped by tmux

    // Commands: success, error, a reply line that looks like a guard, a parse error.
    const ok = single(r, "display-message -p 'ok #{pane_id} #{pane_width}x#{pane_height}'");
    expect(ok.ok).toBe(true);
    expect(text(ok.lines)).toEqual(['ok %0 80x24']);
    expect(single(r, 'select-pane -t %99')).toMatchObject({ ok: false });
    expect(text(single(r, "display-message -p '%%end 1 2 1'").lines)).toEqual(['%end 1 2 1']);
    const parseError = single(r, 'no-such-command');
    expect(parseError.ok).toBe(false);
    expect(text(parseError.lines)[0]).toMatch(/^parse error: unknown command/);
    for (const word of ['one', 'two', 'three']) {
      expect(text(single(r, `display-message -p ${word}`).lines)).toEqual([word]);
    }

    // Resize: the reply, then %layout-change with the new single-pane geometry.
    expect(single(r, 'refresh-client -C 100x30').ok).toBe(true);
    const layout = r.events.find((e) => e.type === 'layoutChange');
    expect(layout?.type === 'layoutChange' && singlePaneLayout(layout.layout)).toEqual({
      width: 100,
      height: 30,
      paneId: 0,
    });

    // Snapshot batch: four blocks plus a matching sentinel; state line is TAB-separated.
    const snapshot = batch(r, 'capture-pane -p -e -J -N -t %0 -S - -E -');
    expect(snapshot.ok).toBe(true);
    expect(snapshot.blocks).toHaveLength(4);
    expect(text(snapshot.blocks[0]!.lines).join('\n')).toContain('é中😀');
    expect(text(snapshot.blocks[2]!.lines)[0]!.split('\t').slice(0, 3)).toEqual([
      '%0',
      '100',
      '30',
    ]);

    // A failing middle command ends the line: no block for the rest, no sentinel.
    const failing = batch(r, 'display-message -p before');
    expect(failing.ok).toBe(false);
    expect(failing.blocks.map((b) => b.ok)).toEqual([true, false]);

    // pause-after switches output to %extended-output.
    expect(r.events.some((e) => e.type === 'extendedOutput')).toBe(true);

    // kill-server: its reply arrives before %exit, which ends the transcript.
    expect(single(r, 'kill-server').ok).toBe(true);
    expect(r.events.at(-1)).toEqual({ type: 'exit' });
  });

  it('places %pause/%continue from refresh-client -A according to the version quirk', async () => {
    const r = await replay(meta, bin, variants['recorded chunks']);
    const pause = single(r, "refresh-client -A '%0:pause'");
    const resume = single(r, "refresh-client -A '%0:continue'");
    const message = single(r, "display-message 'msg-text'");
    if (meta.tmuxVersion === 'tmux 3.8') {
      // Fixed upstream: written as real notifications after the reply block.
      expect(pause.lines).toEqual([]);
      expect(resume.lines).toEqual([]);
      expect(r.events).toContainEqual({ type: 'pause', paneId: 0 });
      expect(r.events).toContainEqual({ type: 'continue', paneId: 0 });
    } else {
      // tmux 3.2a/3.4 write them INSIDE the reply block, where they are data.
      expect(text(pause.lines)).toEqual(['%pause %0']);
      expect(text(resume.lines)).toEqual(['%continue %0']);
      expect(r.events.some((e) => e.type === 'pause' || e.type === 'continue')).toBe(false);
    }
    // %message for a control client: absent on 3.2a, inside the block on 3.4+.
    expect(text(message.lines)).toEqual(
      meta.tmuxVersion === 'tmux 3.2a' ? [] : ['%message msg-text'],
    );
  });
});

describe.each(IMAGES)('recorded attach to an existing session (%s)', (image) => {
  it('attaches without screen content, detaches the stale client and exits with the shell', async () => {
    const { meta, bin } = load(image, 'attach');
    const r = await replay(
      meta,
      bin,
      meta.chunks.map(([, length]) => length),
    );
    expect(r.errors).toEqual([]);
    const firstOutput = r.events.findIndex((e) => e.type === 'output');
    const sessionChanged = r.events.findIndex((e) => e.type === 'sessionChanged');
    expect(sessionChanged).toBeGreaterThan(-1);
    expect(firstOutput).toBeGreaterThan(sessionChanged); // attaching sends no screen content
    const clients = r.results.get(
      "list-clients -F '#{client_name} #{client_control_mode} #{client_pid}'",
    );
    expect(clients && 'lines' in clients && clients.lines).toHaveLength(2);
    const detached = r.events.find((e) => e.type === 'clientDetached');
    expect(detached).toMatchObject({ client: expect.stringMatching(/^client-\d+$/) });
    // The shell's last output may be cut: tmux 3.8 sent %exit before flushing "it\r\nlogout".
    expect(outputOf(r.events)).toMatch(/^ex/);
    expect(r.events.at(-1)).toEqual({ type: 'exit' });
  });
});
