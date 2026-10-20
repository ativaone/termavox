/**
 * Snapshot boundary for tmux control mode (plan §6.8, spike S3, ADR-0003).
 *
 * tmux queues a pane's `%output` for control clients before it parses the same bytes into the
 * grid, and queues command replies behind pending output; the commands of one stdin line run
 * back to back with no pane read in between. Hence, for a snapshot batch:
 *  - pane output received before the batch's first `%begin` is already in the capture: drop it;
 *  - pane output (and layout changes) after the batch's last `%end` came later: hold it while the
 *    emulator is rebuilt, then apply it in order;
 *  - output between the first `%begin` and the last `%end` cannot happen; it is counted as a
 *    violation and the driver retakes the snapshot.
 */

import { Utf8Aligner } from '@termavox/terminal-config';
import type { Dimensions } from '../../core/types.ts';

export type StreamEvent =
  | { kind: 'output'; data: Uint8Array }
  | { kind: 'resize'; dims: Dimensions };

/**
 * - `live`: no snapshot in progress, events go straight to the runtime;
 * - `armed`: a snapshot batch is (about to be) written, its reply has not started;
 * - `capturing`: between the batch's first `%begin` and its last `%end`;
 * - `rebuilding`: the reply is complete and the emulator is being rebuilt.
 */
export type GatePhase = 'live' | 'armed' | 'capturing' | 'rebuilding';

export type GateVerdict = 'forward' | 'drop' | 'hold';

export interface GateStats {
  /** Output bytes dropped because the capture contains them. */
  droppedBytes: number;
  /** Output bytes held during a rebuild and applied after it. */
  heldBytes: number;
  /** Output events seen while a batch reply was being received. */
  violations: number;
}

const EMPTY = new Uint8Array(0);

export class OutputGate {
  #phase: GatePhase;
  #held: StreamEvent[] = [];
  /** Tracks the incomplete UTF-8 character at the end of the pane output stream. */
  readonly #utf8 = new Utf8Aligner();
  #carry: Uint8Array = EMPTY;
  #violated = false;
  readonly stats: GateStats = { droppedBytes: 0, heldBytes: 0, violations: 0 };

  /** Starts `armed`: on attach, everything before the first capture is contained in it. */
  constructor(phase: GatePhase = 'armed') {
    this.#phase = phase;
  }

  get phase(): GatePhase {
    return this.#phase;
  }

  /** Output arrived while the batch reply was being received (the current capture is suspect). */
  get violated(): boolean {
    return this.#violated;
  }

  /**
   * The incomplete UTF-8 character that ended the output stream when the batch reply began.
   * tmux keeps such a character in its parser, outside the grid and outside `-P`, so the rebuild
   * replays it (only when tmux's parser was in the ground state).
   */
  get carry(): Uint8Array {
    return this.#carry;
  }

  /** A snapshot batch is about to be written. */
  arm(): void {
    if (this.#phase !== 'live') throw new Error(`OutputGate.arm() in phase ${this.#phase}`);
    this.#phase = 'armed';
  }

  /** The batch's first reply block began. */
  begin(): void {
    this.#phase = 'capturing';
    this.#violated = false;
    this.#carry = this.#utf8.pending.slice();
  }

  /** The batch's last reply block ended. */
  end(): void {
    this.#phase = 'rebuilding';
  }

  /** The capture failed or is suspect: wait for the next batch; held events are in it. */
  retake(): void {
    this.#phase = 'armed';
    this.#held = [];
    this.#violated = false;
  }

  /** The rebuilt emulator is in place: returns the held events in order and goes live. */
  release(): StreamEvent[] {
    const held = this.#held;
    this.#held = [];
    this.#phase = 'live';
    return held;
  }

  /** Classifies a pane event; held events are kept for `release()`. */
  push(event: StreamEvent): GateVerdict {
    if (event.kind === 'output') this.#utf8.push(event.data);
    switch (this.#phase) {
      case 'live':
        return 'forward';
      case 'armed':
        if (event.kind === 'output') this.stats.droppedBytes += event.data.byteLength;
        return 'drop';
      case 'capturing':
        if (event.kind === 'output') {
          this.stats.violations++;
          this.#violated = true;
        }
        return 'drop';
      case 'rebuilding':
        if (event.kind === 'output') this.stats.heldBytes += event.data.byteLength;
        this.#held.push(event);
        return 'hold';
    }
  }
}
