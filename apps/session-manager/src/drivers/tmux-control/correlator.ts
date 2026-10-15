import { randomToken } from '@termdock/shared';
import { displayLiteral } from './commands.ts';
import type { BlockGuard, ControlEvent } from './parser.ts';

export interface CommandResult {
  /** false when tmux answered with `%error`. */
  ok: boolean;
  /** Raw reply lines (not decoded). */
  lines: Uint8Array[];
}

export interface BatchResult {
  /** false when a command failed; tmux then skips the rest of the line. */
  ok: boolean;
  /** One entry per command that produced a block, in order (the sentinel excluded). */
  blocks: CommandResult[];
}

/** The reply stream no longer matches the commands we sent: resync (plan §6.4). */
export class TmuxDesyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxDesyncError';
  }
}

interface Pending {
  /** Number of commands on the line: tmux answers each with its own block. */
  commands: number;
  blocks: CommandResult[];
  nonce: string | null;
  resolve: (blocks: CommandResult[]) => void;
  reject: (err: Error) => void;
}

/**
 * FIFO correlation of control-mode replies with the command lines we wrote (plan §6.4).
 *
 * Observed framing (ADR-0002, tmux 3.2a–3.8): every command on a line gets its own
 * `%begin … %end|%error` block with flags bit 0 set; when one fails, tmux drops the remaining
 * commands of that line (no blocks for them), and a parse error yields a single `%error` block
 * for the whole line. Blocks with flags 0 (the launch argv commands) are unsolicited.
 */
export interface CorrelatorOptions {
  /** Sentinel generator for sendBatch (tests inject recorded nonces). */
  nonce?: () => string;
}

export class CommandCorrelator {
  readonly #write: (line: string) => void;
  readonly #nonce: () => string;
  readonly #queue: Pending[] = [];
  #active: Pending | null = null;
  #failed: Error | null = null;

  /** `write` receives one command line without the trailing `\n`. */
  constructor(write: (line: string) => void, options: CorrelatorOptions = {}) {
    this.#write = write;
    this.#nonce = options.nonce ?? (() => `td-${randomToken(12)}`);
  }

  /** Lines written and not fully answered yet. */
  get pending(): number {
    return this.#queue.length;
  }

  /** Sends one tmux command (it must not contain `;` separators or newlines). */
  async send(command: string): Promise<CommandResult> {
    const [block] = await this.#enqueue([command], null);
    return block ?? { ok: false, lines: [] };
  }

  /**
   * Sends commands on ONE line (`a ; b ; …`, so tmux runs them back to back) followed by a
   * `display-message -p 'td-<nonce>'` sentinel. Rejects with TmuxDesyncError when the final
   * block is not exactly the sentinel line.
   */
  async sendBatch(commands: readonly string[]): Promise<BatchResult> {
    if (commands.length === 0) throw new RangeError('sendBatch needs at least one command');
    const nonce = this.#nonce();
    const blocks = await this.#enqueue([...commands, displayLiteral(nonce)], nonce);
    if (blocks.length <= commands.length || blocks.some((b) => !b.ok)) {
      return { ok: false, blocks };
    }
    return { ok: true, blocks: blocks.slice(0, commands.length) };
  }

  /**
   * Feeds a parser event. Returns true when the event was a block (consumed here); unsolicited
   * blocks (flags 0) are consumed without touching the queue. Throws TmuxDesyncError (and fails
   * every pending command) on an unexpected reply.
   */
  handle(event: ControlEvent): boolean {
    switch (event.type) {
      case 'blockBegin':
        if (!isSolicited(event.guard)) return true;
        if (this.#active) this.#desync('nested %begin while a reply is open');
        this.#active = this.#queue[0] ?? null;
        if (!this.#active) this.#desync(`reply ${event.guard.raw} with no command pending`);
        return true;
      case 'blockEnd':
      case 'blockError': {
        if (!isSolicited(event.guard)) return true;
        const entry = this.#active;
        if (!entry || entry !== this.#queue[0])
          this.#desync(`reply end ${event.guard.raw} unmatched`);
        this.#active = null;
        const ok = event.type === 'blockEnd';
        entry.blocks.push({ ok, lines: event.lines });
        if (!ok || entry.blocks.length === entry.commands) {
          this.#queue.shift();
          this.#finish(entry);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Rejects every pending command (channel closed, `%exit`, desync). Further sends reject. */
  failAll(err: Error): void {
    this.#failed ??= err;
    this.#active = null;
    for (const entry of this.#queue.splice(0)) entry.reject(err);
  }

  #enqueue(commands: string[], nonce: string | null): Promise<CommandResult[]> {
    if (this.#failed) return Promise.reject(this.#failed);
    for (const command of commands) {
      if (/[\r\n]/.test(command) || command.trim() === '') {
        return Promise.reject(new RangeError('a tmux command must be one non-empty line'));
      }
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ commands: commands.length, blocks: [], nonce, resolve, reject });
      this.#write(commands.join(' ; '));
    });
  }

  #finish(entry: Pending): void {
    const last = entry.blocks.at(-1);
    if (entry.nonce !== null && last?.ok && entry.blocks.length === entry.commands) {
      const sentinel = last.lines.length === 1 ? new TextDecoder().decode(last.lines[0]) : null;
      if (sentinel !== entry.nonce) {
        const err = new TmuxDesyncError(`batch sentinel mismatch (expected ${entry.nonce})`);
        entry.reject(err);
        this.failAll(err);
        throw err;
      }
    }
    entry.resolve(entry.blocks);
  }

  #desync(message: string): never {
    const err = new TmuxDesyncError(message);
    this.failAll(err);
    throw err;
  }
}

function isSolicited(guard: BlockGuard): boolean {
  return (guard.flags & 1) === 1;
}
