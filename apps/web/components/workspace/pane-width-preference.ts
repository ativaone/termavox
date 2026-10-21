'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * How wide the desktop pane area is drawn, in percent of the room beside the sidebar (100: all
 * of it), so a lone pane can be narrowed without a split. Remembered per browser in
 * localStorage, like the sidebar mode; the server (and a browser without storage) renders the
 * full width. Every storage access is guarded: private windows and blocked site data must not
 * break the page.
 */
export const FULL_WIDTH = 100;

const KEY = 'termavox.paneWidth';
const listeners = new Set<() => void>();

function read(): number {
  try {
    const value = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 && value < FULL_WIDTH ? value : FULL_WIDTH;
  } catch {
    return FULL_WIDTH;
  }
}

function write(width: number): void {
  try {
    if (width >= FULL_WIDTH) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(Math.round(width * 10) / 10));
  } catch {
    // Storage unavailable: the area stays at the width storage reads back (full).
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function usePaneWidth(): [number, (width: number) => void] {
  const width = useSyncExternalStore(subscribe, read, () => FULL_WIDTH);
  const set = useCallback((next: number) => write(next), []);
  return [width, set];
}
