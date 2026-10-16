/**
 * Minimal observable value with the `subscribe` / `getSnapshot` shape React's
 * `useSyncExternalStore` expects: the snapshot keeps its identity until it changes.
 */
export class Store<T> {
  #state: T;
  readonly #listeners = new Set<() => void>();

  constructor(initial: T) {
    this.#state = initial;
  }

  readonly getSnapshot = (): T => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(next: T): void {
    if (Object.is(next, this.#state)) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }

  update(patch: Partial<T>): void {
    this.set({ ...this.#state, ...patch });
  }
}
