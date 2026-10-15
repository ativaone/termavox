import type { RawPtyDriverOptions } from '../../core/driver-factory.ts';
import type { Dimensions, Driver, DriverContext, PtyChannel } from '../../core/types.ts';

/**
 * Protection `none` (plan §5.2): an interactive PTY shell over the transport. The remote shell
 * lives exactly as long as the connection, so `detach()` cannot keep it alive.
 */
export class RawPtyDriver implements Driver {
  readonly protection = 'none' as const;
  readonly #options: RawPtyDriverOptions;
  #channel: PtyChannel | null = null;
  #stopped = false;

  constructor(options: RawPtyDriverOptions) {
    this.#options = options;
  }

  async start(ctx: DriverContext, dims: Dimensions): Promise<void> {
    const channel = await ctx.transport.openPty({
      cols: dims.cols,
      rows: dims.rows,
      term: this.#options.term,
      env: this.#options.env,
    });
    if (this.#stopped) {
      channel.end();
      return;
    }
    this.#channel = channel;
    void (async () => {
      for await (const chunk of channel.stdout) ctx.output(chunk);
    })().catch(() => {
      // stdout ends with the channel; the exit promise below reports it.
    });
    void channel.exit.then((result) => {
      // A channel closed by a lost connection carries no exit status; the runtime tells the two
      // apart (the transport's onLost is authoritative).
      if (!this.#stopped) ctx.onShellExit({ code: result.code });
    });
  }

  input(data: Uint8Array): void {
    this.#channel?.write(data);
  }

  resize(dims: Dimensions): void {
    this.#channel?.resize(dims);
  }

  pauseOutput(): void {
    this.#channel?.pause();
  }

  resumeOutput(): void {
    this.#channel?.resume();
  }

  /** A raw shell cannot outlive the connection: nothing to leave behind. */
  async detach(): Promise<void> {}

  async terminate(): Promise<void> {
    this.#stopped = true;
    this.#channel?.end();
  }
}
