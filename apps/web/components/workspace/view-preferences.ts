'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * Per-browser view sizes, kept in localStorage like the sidebar mode (sidebar-preference.ts) and
 * never in the saved layout: the pane area's margins, so a lone pane can be narrowed without a
 * split, and the expanded sidebar's width. The server (and a browser without storage) renders
 * the defaults. Every storage access is guarded: private windows and blocked site data must not
 * break the page.
 */

const AREA_KEY = 'termavox.paneArea';
const SIDEBAR_KEY = 'termavox.sidebarWidth';
const listeners = new Set<() => void>();

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the view keeps what storage reads back (the default).
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === AREA_KEY || event.key === SIDEBAR_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

const readArea = (): string | null => readRaw(AREA_KEY);
const readSidebar = (): string | null => readRaw(SIDEBAR_KEY);
const serverRaw = (): string | null => null;

// ── pane area ────────────────────────────────────────────────────────────────

/** The pane area's margins, in percent of the room beside the sidebar ({0, 0}: all of it). */
export interface PaneArea {
  start: number;
  end: number;
}

export const FULL_AREA: PaneArea = { start: 0, end: 0 };

const margin = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100 ? value : 0;

function parseArea(raw: string | null): PaneArea {
  if (!raw) return FULL_AREA;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return FULL_AREA;
    const { start, end } = value as Record<string, unknown>;
    const area = { start: margin(start), end: margin(end) };
    return area.start + area.end < 100 ? area : FULL_AREA;
  } catch {
    return FULL_AREA;
  }
}

const tenth = (value: number): number => Math.round(value * 10) / 10;

export function usePaneArea(): [PaneArea, (area: PaneArea) => void] {
  // The raw string is the snapshot: parsing in it would hand React a new object every read.
  const raw = useSyncExternalStore(subscribe, readArea, serverRaw);
  const area = useMemo(() => parseArea(raw), [raw]);
  const set = useCallback((next: PaneArea) => {
    const start = tenth(next.start);
    const end = tenth(next.end);
    writeRaw(AREA_KEY, start > 0 || end > 0 ? JSON.stringify({ start, end }) : null);
  }, []);
  return [area, set];
}

// ── sidebar ──────────────────────────────────────────────────────────────────

/** The expanded sidebar's width bounds, in CSS px; it never takes more than half the window. */
export const SIDEBAR_MIN_PX = 240;
export const SIDEBAR_MAX_PX = 480;
/** The default (`--sidebar-width`, 18 rem) at the browser's default text size. */
export const SIDEBAR_DEFAULT_PX = 288;

function parseSidebar(raw: string | null): number | null {
  const value = Number(raw);
  return raw && Number.isFinite(value) && value >= SIDEBAR_MIN_PX && value <= SIDEBAR_MAX_PX
    ? value
    : null;
}

/** The stored sidebar width in CSS px, or null for the default. */
export function useSidebarWidth(): [number | null, (width: number | null) => void] {
  const width = parseSidebar(useSyncExternalStore(subscribe, readSidebar, serverRaw));
  const set = useCallback(
    (next: number | null) => writeRaw(SIDEBAR_KEY, next === null ? null : String(Math.round(next))),
    [],
  );
  return [width, set];
}
