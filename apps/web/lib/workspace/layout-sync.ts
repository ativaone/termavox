import { WorkspaceLayout } from '@termdock/protocol/client';
import { type LayoutAction, layoutReducer, normalizeLayout } from './tree.ts';

/**
 * Keeps the workspace layout and its server copy in step (plan §8.2, §11.1). Edits apply locally
 * at once; saves are debounced (1 s) and sent as `PUT /api/layout` with `If-Match: <version>`.
 * On 409 the stored layout is reloaded and the edits not yet saved are replayed on top of it
 * (the reducer is deterministic), then saved once more; a further conflict waits for the next
 * round. Exposes the `subscribe` / `getSnapshot` pair `useSyncExternalStore` expects.
 */

export interface StoredLayout {
  layout: WorkspaceLayout;
  version: number;
}

export type PutResult =
  | { kind: 'ok'; version: number }
  | { kind: 'conflict' }
  | { kind: 'unauthenticated' }
  | { kind: 'error' };

export interface LayoutTransport {
  get(): Promise<StoredLayout | null>;
  put(
    layout: WorkspaceLayout,
    version: number,
    options?: { keepalive?: boolean },
  ): Promise<PutResult>;
}

export const SAVE_DEBOUNCE_MS = 1_000;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];

export interface LayoutSyncOptions {
  debounceMs?: number;
  /** Called once when the server says the auth session is gone. */
  onUnauthenticated?(): void;
}

export class LayoutSync {
  #base: WorkspaceLayout;
  #version: number;
  #pending: LayoutAction[] = [];
  #current: WorkspaceLayout;
  readonly #transport: LayoutTransport;
  readonly #options: LayoutSyncOptions;
  readonly #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight = false;
  #failures = 0;
  #stopped = false;

  constructor(initial: StoredLayout, transport: LayoutTransport, options: LayoutSyncOptions = {}) {
    this.#base = normalizeLayout(initial.layout);
    this.#version = initial.version;
    this.#current = this.#base;
    this.#transport = transport;
    this.#options = options;
  }

  readonly getSnapshot = (): WorkspaceLayout => this.#current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  get version(): number {
    return this.#version;
  }

  /** True while edits wait to be saved. */
  get dirty(): boolean {
    return this.#pending.length > 0;
  }

  /** Applies an edit now and schedules a save. No-op edits are dropped. */
  dispatch(action: LayoutAction): WorkspaceLayout {
    const next = layoutReducer(this.#current, action);
    if (next === this.#current || this.#stopped) return this.#current;
    this.#pending.push(action);
    this.#setCurrent(next);
    this.#schedule(this.#options.debounceMs ?? SAVE_DEBOUNCE_MS);
    return next;
  }

  /** Saves now (debounce skipped). */
  flush(): Promise<void> {
    this.#clearTimer();
    return this.#save();
  }

  /** Best-effort save while the page goes away (`keepalive`); no conflict handling. */
  flushOnExit(): void {
    if (this.#pending.length === 0 || this.#inFlight || this.#stopped) return;
    this.#clearTimer();
    void this.#transport.put(this.#current, this.#version, { keepalive: true });
  }

  dispose(): void {
    this.#stopped = true;
    this.#clearTimer();
    this.#listeners.clear();
  }

  #setCurrent(next: WorkspaceLayout): void {
    if (next === this.#current) return;
    this.#current = next;
    for (const listener of [...this.#listeners]) listener();
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#save();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #replay(): WorkspaceLayout {
    return this.#pending.reduce(layoutReducer, this.#base);
  }

  async #save(): Promise<void> {
    if (this.#inFlight || this.#stopped || this.#pending.length === 0) return;
    this.#inFlight = true;
    let retryLater = false;
    try {
      let result = await this.#put();
      if (result.kind === 'conflict') {
        const stored = await this.#transport.get().catch(() => null);
        if (stored && !this.#stopped) {
          this.#base = normalizeLayout(stored.layout);
          this.#version = stored.version;
          this.#setCurrent(this.#replay());
          result = await this.#put();
        }
        if (result.kind === 'conflict') retryLater = true;
      }
      if (result.kind === 'unauthenticated') {
        this.#stopped = true;
        this.#options.onUnauthenticated?.();
      } else if (result.kind === 'error') {
        retryLater = true;
      }
    } finally {
      this.#inFlight = false;
    }
    if (this.#stopped) return;
    if (retryLater) {
      const delay = RETRY_MS[Math.min(this.#failures, RETRY_MS.length - 1)]!;
      this.#failures++;
      this.#schedule(delay);
    } else if (this.#pending.length > 0) {
      this.#schedule(this.#options.debounceMs ?? SAVE_DEBOUNCE_MS);
    }
  }

  /** PUTs the current layout; on success the saved edits leave the pending list. */
  async #put(): Promise<PutResult> {
    const snapshot = this.#current;
    const count = this.#pending.length;
    const result = await this.#transport
      .put(snapshot, this.#version)
      .catch((): PutResult => ({ kind: 'error' }));
    if (result.kind === 'ok') {
      this.#failures = 0;
      this.#base = snapshot;
      this.#version = result.version;
      this.#pending = this.#pending.slice(count);
    }
    return result;
  }
}

export const LAYOUT_PATH = '/api/layout';

/** `fetch` transport for the browser (same-origin, cookie-authenticated). */
export const fetchLayoutTransport: LayoutTransport = {
  async get() {
    const res = await fetch(LAYOUT_PATH, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { layout?: unknown; version?: unknown };
    const layout = WorkspaceLayout.safeParse(body.layout);
    if (!layout.success || typeof body.version !== 'number') return null;
    return { layout: layout.data, version: body.version };
  },
  async put(layout, version, options) {
    const res = await fetch(LAYOUT_PATH, {
      method: 'PUT',
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: options?.keepalive ?? false,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'if-match': `"${version}"`,
      },
      body: JSON.stringify(layout),
    });
    if (res.status === 409) return { kind: 'conflict' };
    if (res.status === 401) return { kind: 'unauthenticated' };
    if (!res.ok) return { kind: 'error' };
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'number'
      ? { kind: 'ok', version: body.version }
      : { kind: 'error' };
  },
};
