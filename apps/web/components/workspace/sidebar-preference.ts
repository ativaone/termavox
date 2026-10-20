'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether the session sidebar is the full list or the narrow rail (plan D-28). Remembered per
 * browser in localStorage; the server (and a browser without storage) renders the full list.
 * Every storage access is guarded: private windows and blocked site data must not break the page.
 */
export type SidebarMode = 'expanded' | 'rail';

const KEY = 'termavox.sidebar';
const listeners = new Set<() => void>();

function read(): SidebarMode {
  try {
    return window.localStorage.getItem(KEY) === 'rail' ? 'rail' : 'expanded';
  } catch {
    return 'expanded';
  }
}

function write(mode: SidebarMode): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
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

export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
  const mode = useSyncExternalStore(subscribe, read, () => 'expanded' as const);
  const set = useCallback((next: SidebarMode) => write(next), []);
  return [mode, set];
}
