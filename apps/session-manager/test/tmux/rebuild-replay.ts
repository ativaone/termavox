/**
 * Loads and replays the snapshot/rebuild transcripts recorded by record-rebuild-fixtures.ts:
 * stdout bytes go through splitter → parser → correlator, every recorded command line is
 * re-issued at its recorded stdout offset, and each snapshot batch reports the event indexes of
 * its first `%begin` and last `%end` (the boundary).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  CommandCorrelator,
  type CommandResult,
  type ControlEvent,
  ControlParser,
  LineSplitter,
} from '../../src/drivers/tmux-control/index.ts';

export const REBUILD_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/tmux/', import.meta.url));
export const REBUILD_IMAGES = ['tmux-3.2a', 'tmux-3.4', 'tmux-edge'] as const;
const SENTINEL = / ; display-message -p '(td-[a-z2-7]+)'$/;

export interface RebuildScenarioMeta {
  name: string;
  /** No pane output is expected between the capture and the next input. */
  static: boolean;
  /** stdout offset when the scenario's command was typed. */
  startAtByte: number;
}

export interface RebuildFixtureMeta {
  image: string;
  tmuxVersion: string;
  recordedAt: string;
  description: string;
  cols: number;
  rows: number;
  historyLimit: number;
  /** One entry per snapshot batch, in order. */
  scenarios: RebuildScenarioMeta[];
  /** Command lines written to the control client, with the stdout byte offset at send time. */
  sent: Array<{ atByte: number; line: string }>;
}

export function loadRebuildFixture(image: string): { meta: RebuildFixtureMeta; bin: Uint8Array } {
  const dir = `${REBUILD_FIXTURE_DIR}${image}/`;
  return {
    meta: JSON.parse(readFileSync(`${dir}rebuild.json`, 'utf8')) as RebuildFixtureMeta,
    bin: new Uint8Array(gunzipSync(readFileSync(`${dir}rebuild.bin.gz`))),
  };
}

export interface ReplayedBatch extends RebuildScenarioMeta {
  /** Event count when the scenario's command was typed. */
  startIndex: number;
  /** Event count when the batch line was written. */
  issueIndex: number;
  /** Index of the batch's first `%begin` event and of its last `%end` event. */
  beginIndex: number;
  endIndex: number;
  ok: boolean;
  blocks: CommandResult[];
}

export interface Replay {
  events: ControlEvent[];
  batches: ReplayedBatch[];
}

export async function replayRebuildTranscript(
  meta: Pick<RebuildFixtureMeta, 'sent' | 'scenarios'>,
  bin: Uint8Array,
  chunkSize = 4096,
): Promise<Replay> {
  const events: ControlEvent[] = [];
  const batches: ReplayedBatch[] = [];
  let nonce = '';
  const correlator = new CommandCorrelator(() => {}, { nonce: () => nonce });
  const parser = new ControlParser();
  const splitter = new LineSplitter();
  const pending: Promise<unknown>[] = [];
  const startIndexes: number[] = [];
  let step = 0;

  const issueDue = (offset: number): void => {
    while (step < meta.sent.length && meta.sent[step]!.atByte <= offset) {
      const { line } = meta.sent[step++]!;
      const sentinel = SENTINEL.exec(line);
      if (!sentinel) {
        pending.push(correlator.send(line).catch(() => {}));
        continue;
      }
      nonce = sentinel[1]!;
      const scenario = meta.scenarios[batches.length];
      if (!scenario) throw new Error(`batch ${batches.length} has no scenario`);
      const batch: ReplayedBatch = {
        ...scenario,
        startIndex: -1,
        issueIndex: events.length,
        beginIndex: -1,
        endIndex: -1,
        ok: false,
        blocks: [],
      };
      batches.push(batch);
      const commands = line.slice(0, sentinel.index).split(' ; ');
      pending.push(
        correlator
          .sendBatch(commands, {
            onBegin: () => {
              batch.beginIndex = events.length;
            },
            onEnd: () => {
              batch.endIndex = events.length;
            },
          })
          .then((result) => {
            batch.ok = result.ok;
            batch.blocks = result.blocks;
          }),
      );
    }
  };

  const starts = meta.scenarios.map((s) => s.startAtByte);
  for (let offset = 0; offset < bin.byteLength; ) {
    issueDue(offset);
    while (startIndexes.length < starts.length && starts[startIndexes.length]! <= offset) {
      startIndexes.push(events.length);
    }
    // Cut chunks at the next send / scenario offset so each line is queued before its reply.
    const nextSend = meta.sent[step]?.atByte ?? Number.POSITIVE_INFINITY;
    const nextStart = starts[startIndexes.length] ?? Number.POSITIVE_INFINITY;
    const cut = Math.min(nextSend, nextStart);
    const end = Math.min(offset + chunkSize, bin.byteLength, cut > offset ? cut : bin.byteLength);
    for (const line of splitter.push(bin.subarray(offset, end))) {
      const event = parser.push(line);
      if (!event) continue;
      correlator.handle(event);
      events.push(event);
    }
    offset = end;
  }
  issueDue(bin.byteLength);
  correlator.failAll(new Error('end of transcript'));
  await Promise.all(pending);
  batches.forEach((batch, i) => {
    batch.startIndex = startIndexes[i] ?? events.length;
  });
  return { events, batches };
}

/** Pane-0 output events in [from, to). */
export function outputBetween(events: readonly ControlEvent[], from: number, to: number): number {
  let count = 0;
  for (let i = Math.max(from, 0); i < Math.min(to, events.length); i++) {
    const e = events[i]!;
    if ((e.type === 'output' || e.type === 'extendedOutput') && e.paneId === 0) count++;
  }
  return count;
}
