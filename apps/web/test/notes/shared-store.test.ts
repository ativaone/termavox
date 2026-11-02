import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachPageEvents,
  discardSharedNotesStore,
  leaveNotesOnSignOut,
  sharedNotesStore,
} from '../../lib/notes/shared-store.ts';
import { NotesStore } from '../../lib/notes/store.ts';

function page() {
  const events = new EventTarget();
  return {
    addEventListener: vi.fn((type: string, fn: EventListener) => events.addEventListener(type, fn)),
    removeEventListener: vi.fn((type: string, fn: EventListener) =>
      events.removeEventListener(type, fn),
    ),
    visibilityState: 'visible' as DocumentVisibilityState,
    fire(type: string) {
      const event = new Event(type, { cancelable: true });
      events.dispatchEvent(event);
      return event;
    },
  };
}

function inBrowser() {
  const win = page();
  const doc = page();
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  return { win, doc };
}

afterEach(() => {
  discardSharedNotesStore();
  vi.unstubAllGlobals();
});

describe('the tab-wide notes store', () => {
  it('is the same store when the shell comes back, with the counts of the new first paint', () => {
    inBrowser();
    const first = sharedNotesStore('ann', { a: 1 });
    const second = sharedNotesStore('ann', { a: 2, b: 1 });
    expect(second).toBe(first);
    expect(second.getCounts()).toEqual({ a: 2, b: 1 });
  });

  it("never hands one user's store to another, and empties the old one", () => {
    inBrowser();
    const ann = sharedNotesStore('ann', { a: 1 });
    const dispose = vi.spyOn(ann, 'dispose');
    const ben = sharedNotesStore('ben', {});
    expect(ben).not.toBe(ann);
    expect(dispose).toHaveBeenCalledOnce();
    expect(ann.getCounts()).toEqual({});
  });

  it('is never shared on the server, where a module serves every request', () => {
    expect(typeof window).toBe('undefined');
    const first = sharedNotesStore('ann', { a: 1 });
    expect(sharedNotesStore('ann', { a: 1 })).not.toBe(first);
  });

  it('signing out flushes what it can and drops the store', () => {
    inBrowser();
    const ann = sharedNotesStore('ann', { a: 1 });
    const flush = vi.spyOn(ann, 'flushOnExit');
    leaveNotesOnSignOut();
    expect(flush).toHaveBeenCalledOnce();
    expect(ann.getCounts()).toEqual({});
    expect(sharedNotesStore('ann', {})).not.toBe(ann);
  });

  it('a discarded store leaves no page listeners behind', () => {
    const { win, doc } = inBrowser();
    sharedNotesStore('ann', {});
    expect(win.addEventListener).toHaveBeenCalled();
    discardSharedNotesStore();
    for (const target of [win, doc]) {
      expect(target.removeEventListener.mock.calls.length).toBeGreaterThanOrEqual(
        target.addEventListener.mock.calls.length,
      );
    }
  });
});

describe('page events on a notes store', () => {
  /** A store with one loaded note whose saves never answer. */
  async function withLoadedNote() {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/notes')
        ? Response.json({
            notes: [{ id: 'n', title: 't', revision: 1, createdAt: 1, updatedAt: 1, bytes: 0 }],
          })
        : Response.json({
            note: {
              id: 'n',
              title: 't',
              revision: 1,
              createdAt: 1,
              updatedAt: 1,
              bytes: 0,
              body: '',
            },
          }),
    ) as unknown as typeof globalThis.fetch;
    const store = new NotesStore({ fetch });
    store.ensureList('s');
    await vi.waitFor(() => expect(store.getSession('s').list).toBe('ready'));
    store.ensureBody('s', 'n');
    await vi.waitFor(() => expect(store.getNote('s', 'n')?.body).toBe('ready'));
    return store;
  }

  it('asks before leaving only while something is unsaved', async () => {
    const store = await withLoadedNote();
    const win = page();
    const doc = page();
    const detach = attachPageEvents(store, win as never, doc as never);
    expect(win.fire('beforeunload').defaultPrevented).toBe(false);
    store.edit('s', 'n', 'typed');
    expect(win.fire('beforeunload').defaultPrevented).toBe(true);
    store.forget('s');
    expect(win.fire('beforeunload').defaultPrevented).toBe(false);
    detach();
  });

  it('flushes on hidden, keeps on pagehide, retries on online, and detaches', async () => {
    const store = await withLoadedNote();
    const flushAll = vi.spyOn(store, 'flushAll');
    const flushOnExit = vi.spyOn(store, 'flushOnExit');
    const online = vi.spyOn(store, 'online');
    const win = page();
    const doc = page();
    const detach = attachPageEvents(store, win as never, doc as never);
    doc.fire('visibilitychange');
    expect(flushAll).not.toHaveBeenCalled();
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(flushAll).toHaveBeenCalledOnce();
    win.fire('pagehide');
    expect(flushOnExit).toHaveBeenCalledOnce();
    win.fire('online');
    expect(online).toHaveBeenCalledOnce();
    detach();
    win.fire('pagehide');
    win.fire('online');
    expect(flushOnExit).toHaveBeenCalledOnce();
    expect(online).toHaveBeenCalledOnce();
  });
});
