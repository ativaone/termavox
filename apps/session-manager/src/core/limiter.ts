/**
 * Small concurrency helpers: a counting limiter shared by independent callers (the one-shot remote
 * cleanups of terminated sessions, plan D-30) and a bounded `forEach`.
 */

/** Runs at most `max` tasks at once; the others wait in arrival order. */
export class Limiter {
  readonly #max: number;
  #running = 0;
  readonly #queue: Array<() => void> = [];

  constructor(max: number) {
    this.#max = Math.max(1, max);
  }

  get running(): number {
    return this.#running;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * Runs `task` once a slot is free. An abort while it waits rejects with the signal's reason and
   * the task never runs.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.#running < this.#max) {
      this.#running++;
    } else {
      // A finishing task hands its slot over: `#running` stays as it is.
      await new Promise<void>((resolve, reject) => {
        const start = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const index = this.#queue.indexOf(start);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.#queue.push(start);
      });
    }
    try {
      return await task();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#running--;
    }
  }
}

/** Calls `fn` for every item, at most `concurrency` at a time; resolves when all settled. */
export async function forEachLimit<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
}

/** Waits for `promise` at most `ms`; a rejection inside the wait is thrown, a later one is not. */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
