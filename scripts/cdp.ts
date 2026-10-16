// A minimal Chrome DevTools Protocol client for the release smoke (scripts/release-smoke.ts).
// It drives a locally installed headless Chromium over CDP with Node's built-in WebSocket client:
// no browser-automation package, no new dependency. Page-side code is passed as JavaScript
// source strings (the root tsconfig has no DOM types) and runs with a small helper prelude.
import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

type Params = Record<string, unknown>;
type Listener = (params: Params, sessionId: string | undefined) => void;

interface Pending {
  method: string;
  resolve(value: Params): void;
  reject(error: Error): void;
}

/** Helpers available to every page-side expression (`$`, `$$`, `text`, `visible`, `byText`). */
const PRELUDE = `
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const text = (el) => (el?.textContent ?? '').replace(/[\\s\\u00a0]+/g, ' ').trim();
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const byText = (sel, t, root = document) => $$(sel, root).find((el) => visible(el) && text(el) === t) ?? null;
  const hydrated = (el) => !!el && Object.keys(el).some((k) => k.startsWith('__reactFiber'));
`;

export class CdpConnection {
  readonly #ws: WebSocket;
  #nextId = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<Listener>>();
  #closed: Error | null = null;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => this.#onMessage(String(event.data));
    ws.onclose = () => this.#fail(new Error('the DevTools connection closed'));
  }

  static async open(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no DevTools connection to ${url}`)),
        timeoutMs,
      );
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to the DevTools endpoint ${url}`));
      };
    });
    return new CdpConnection(ws);
  }

  send<T = Params>(method: string, params: Params = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { method, resolve: resolve as (value: Params) => void, reject });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, listener: Listener): () => void {
    let set = this.#listeners.get(method);
    if (!set) {
      set = new Set();
      this.#listeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  close(): void {
    this.#fail(new Error('the DevTools connection was closed'));
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #onMessage(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: Params;
      result?: Params;
      error?: { message: string };
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message.sessionId);
      }
    }
  }
}

export class CdpPage {
  readonly connection: CdpConnection;
  readonly sessionId: string;

  constructor(connection: CdpConnection, sessionId: string) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  send<T = Params>(method: string, params: Params = {}): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  on(method: string, listener: (params: Params) => void): () => void {
    return this.connection.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) listener(params);
    });
  }

  /** Evaluates `body` (an expression, may be a promise) with the helper prelude. */
  async evaluate<T>(body: string): Promise<T> {
    const expression = `(async () => {${PRELUDE}\nreturn (${body});\n})()`;
    const result = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(`page error: ${details.exception?.description ?? details.text}`);
    }
    return result.result.value as T;
  }

  /**
   * Polls `body` until it returns a truthy value. Navigation errors (destroyed execution
   * contexts) are retried; the timeout error names `label`.
   */
  async waitFor<T>(body: string, label: string, timeoutMs = 30_000, intervalMs = 150): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate<T>(body);
        if (value) return value;
        lastError = null;
      } catch (err) {
        lastError = err as Error;
        if (!/context|navigat|Target closed|Inspected target/i.test(lastError.message)) {
          throw lastError;
        }
      }
      await sleep(intervalMs);
    }
    const suffix = lastError ? ` (last error: ${lastError.message})` : '';
    throw new Error(
      `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}${suffix}`,
    );
  }

  /**
   * Navigates and waits for the load event. Retried when Chromium reports a network change:
   * Docker adding or removing a container interface (compose up, restart, run) makes it abort
   * in-flight loads with ERR_NETWORK_CHANGED.
   */
  async navigate(url: string, timeoutMs = 60_000): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#navigateOnce(url, timeoutMs);
        return;
      } catch (err) {
        if (attempt >= 5 || !/ERR_NETWORK_CHANGED/.test((err as Error).message)) throw err;
        await sleep(1_000);
      }
    }
  }

  async #navigateOnce(url: string, timeoutMs: number): Promise<void> {
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs / 1000} s loading ${url}`)),
        timeoutMs,
      );
      off = this.on('Page.loadEventFired', () => resolve());
    });
    try {
      const result = await this.send<{ errorText?: string }>('Page.navigate', { url });
      if (result.errorText) throw new Error(`cannot load ${url}: ${result.errorText}`);
      await loaded;
    } finally {
      off();
      clearTimeout(timer);
    }
  }

  /** Waits until the element is rendered and hydrated by React (handlers attached). */
  async waitHydrated(elementExpr: string, label: string, timeoutMs = 30_000): Promise<void> {
    await this.waitFor(`hydrated(${elementExpr})`, `${label} (hydrated)`, timeoutMs);
  }

  /** Clicks an element (scrolled into view; must be visible and enabled). */
  async click(elementExpr: string, label: string, timeoutMs = 30_000): Promise<void> {
    await this.waitFor(
      `(() => { const el = ${elementExpr}; return visible(el) && !el.disabled; })()`,
      `${label} (clickable)`,
      timeoutMs,
    );
    await this.evaluate(
      `(() => { const el = ${elementExpr}; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`,
    );
  }

  /** Replaces a text control's value by focusing it and inserting text, like typing. */
  async fill(elementExpr: string, value: string, label: string): Promise<void> {
    await this.waitFor(`visible(${elementExpr})`, `${label} (visible)`);
    await this.evaluate(
      `(() => { const el = ${elementExpr}; el.focus(); el.select?.(); return true; })()`,
    );
    await this.send('Input.insertText', { text: value });
    const actual = await this.evaluate<string>(`(${elementExpr}).value`);
    if (actual !== value)
      throw new Error(`${label}: the field holds a different value after typing`);
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async pressEnter(): Promise<void> {
    const key = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...key,
      text: '\r',
      unmodifiedText: '\r',
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  async screenshot(path: string): Promise<void> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}

export interface Chromium {
  page: CdpPage;
  connection: CdpConnection;
  close(): Promise<void>;
}

/**
 * Starts headless Chromium with a private profile and a DevTools endpoint on a random loopback
 * port, and opens one page. `close()` ends the browser (SIGKILL after 5 s).
 */
export async function launchChromium(options: {
  executable: string;
  userDataDir: string;
  args?: string[];
}): Promise<Chromium> {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${options.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--mute-audio',
    ...(options.args ?? []),
  ];
  const child = spawn(options.executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let url: string;
  try {
    url = await devtoolsUrl(child);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
  const connection = await CdpConnection.open(url);
  const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const page = new CdpPage(connection, sessionId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return {
    page,
    connection,
    async close() {
      try {
        await Promise.race([connection.send('Browser.close'), sleep(2_000)]);
      } catch {
        // the browser may already be gone
      }
      connection.close();
      const killed = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(killed);
    },
  };
}

function devtoolsUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let found = false;
    const timer = setTimeout(
      () => reject(new Error(`Chromium did not start within 20 s:\n${output.slice(-2_000)}`)),
      20_000,
    );
    // Keeps draining stderr after the endpoint line, so the browser never blocks on the pipe.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (found) return;
      output = (output + chunk.toString()).slice(-20_000);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match?.[1]) {
        found = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited (${signal ?? code}):\n${output.slice(-2_000)}`));
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
