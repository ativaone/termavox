import { EMPTY_LAYOUT, type WorkspaceLayout } from '@termdock/protocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LayoutSync,
  type LayoutTransport,
  type PutResult,
  type StoredLayout,
} from '../../lib/workspace/layout-sync.ts';

/** An in-memory server with the API's compare-and-set semantics. */
function server(initial: StoredLayout) {
  const stored = { ...initial };
  const puts: Array<{ layout: WorkspaceLayout; version: number }> = [];
  const transport: LayoutTransport = {
    get: async () => ({ ...stored }),
    put: async (layout, version): Promise<PutResult> => {
      puts.push({ layout, version });
      if (version !== stored.version) return { kind: 'conflict' };
      stored.layout = layout;
      stored.version++;
      return { kind: 'ok', version: stored.version };
    },
  };
  return { stored, puts, transport };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('layout sync (debounced PUT with If-Match, 409 → reload and re-apply)', () => {
  it('debounces edits into one save and tracks the version', async () => {
    const s = server({ layout: EMPTY_LAYOUT, version: 0 });
    const sync = new LayoutSync({ layout: EMPTY_LAYOUT, version: 0 }, s.transport);
    sync.dispatch({ type: 'openTab', tabId: 't1', paneId: 'p1', sessionId: 's1' });
    sync.dispatch({ type: 'openTab', tabId: 't2', paneId: 'p2', sessionId: null });
    expect(s.puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.puts).toHaveLength(1);
    expect(sync.version).toBe(1);
    expect(sync.dirty).toBe(false);
    expect(s.stored.layout.tabs.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('on a conflict, replays the unsaved edits on the stored layout and saves again', async () => {
    const other: WorkspaceLayout = {
      version: 1,
      activeTabId: 'remote',
      tabs: [
        { id: 'remote', activePaneId: 'r1', root: { type: 'leaf', id: 'r1', sessionId: 'sr' } },
      ],
    };
    // Another browser saved version 1 meanwhile; this one still holds version 0.
    const s = server({ layout: other, version: 1 });
    const sync = new LayoutSync({ layout: EMPTY_LAYOUT, version: 0 }, s.transport);
    sync.dispatch({ type: 'openTab', tabId: 'local', paneId: 'l1', sessionId: 'sl' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(s.puts.map((p) => p.version)).toEqual([0, 1]);
    expect(sync.version).toBe(2);
    const ids = sync.getSnapshot().tabs.map((t) => t.id);
    expect(ids).toEqual(['remote', 'local']);
    expect(s.stored.layout.tabs.map((t) => t.id)).toEqual(['remote', 'local']);
  });

  it('never saves an unchanged layout', async () => {
    const s = server({ layout: EMPTY_LAYOUT, version: 0 });
    const sync = new LayoutSync({ layout: EMPTY_LAYOUT, version: 0 }, s.transport);
    sync.dispatch({ type: 'activateTab', tabId: 'missing' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.puts).toHaveLength(0);
  });
});
