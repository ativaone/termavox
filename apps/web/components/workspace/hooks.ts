'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  TERMINAL_FONT_STACKS,
  TERMINAL_THEMES,
  type TerminalPreferences,
} from '../../lib/preferences/terminal.ts';
import type { TerminalAppearance } from '../../lib/terminal/xterm.ts';

const noopSubscribe = (): (() => void) => () => {};

/** False while hydrating (server markup), true once the client renders on its own. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** The desktop breakpoint (Tailwind `md`, 48rem). The server renders the desktop frame. */
const DESKTOP_QUERY = '(min-width: 48rem)';

function subscribeDesktop(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Desktop or phone, decided in JavaScript because the two mount different terminals: the split
 * tree on desktop, a single pane on a phone. Hiding the split tree with CSS would still attach
 * every pane and measure them at 0 × 0.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

/** A clock for countdowns and uptimes, ticking every `intervalMs`. */
export function useNow(intervalMs: number, enabled = true, initial?: number): number {
  const [now, setNow] = useState(() => initial ?? Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

/**
 * Canvas text (xterm's renderers) cannot read CSS custom properties, so a font stack such as
 * `var(--font-jetbrains), monospace` is resolved against the document first.
 */
export function resolveFontStack(stack: string): string {
  const root = getComputedStyle(document.documentElement);
  return stack.replace(
    /var\((--[\w-]+)\)/g,
    (_match, name: string) => root.getPropertyValue(name).trim() || 'monospace',
  );
}

const FONT_LOAD_TIMEOUT_MS = 3_000;

/**
 * The user's terminal appearance (font, size, colour scheme), available once the font has
 * loaded: xterm measures its cell size when the terminal opens, and a measurement taken with the
 * fallback font would size every session wrong. Null until then.
 */
export function useTerminalAppearance(preferences: TerminalPreferences): TerminalAppearance | null {
  const [appearance, setAppearance] = useState<TerminalAppearance | null>(null);
  const { fontFamily, fontSize, colorScheme } = preferences;
  useEffect(() => {
    let cancelled = false;
    const family = resolveFontStack(TERMINAL_FONT_STACKS[fontFamily]);
    const loads = Promise.all([
      document.fonts.load(`${fontSize}px ${family}`),
      document.fonts.load(`bold ${fontSize}px ${family}`),
    ]).catch(() => []);
    const timeout = new Promise((resolve) => setTimeout(resolve, FONT_LOAD_TIMEOUT_MS));
    void Promise.race([loads, timeout]).then(() => {
      if (cancelled) return;
      setAppearance({
        theme: { ...TERMINAL_THEMES[colorScheme] },
        fontFamily: family,
        fontSize,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [fontFamily, fontSize, colorScheme]);
  return appearance;
}

/** Navigates to the login page (full load: the auth session is gone). */
export function goToLogin(loginHref: string): void {
  window.location.assign(loginHref);
}

export const AUTH_SLIDE_INTERVAL_MS = 10 * 60_000;

/**
 * Terminal traffic never reaches Next.js, so while the workspace is open the auth session's
 * sliding expiry is kept moving by calling Better Auth's get-session every 10 minutes (plan
 * §7.1). No session (401, or Better Auth's `null` body) → the login page.
 */
export function useAuthSessionSlide(loginHref: string, intervalMs = AUTH_SLIDE_INTERVAL_MS): void {
  useEffect(() => {
    const slide = async (): Promise<void> => {
      try {
        const res = await fetch('/api/auth/get-session', {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (res.status === 401) return goToLogin(loginHref);
        if (res.ok && (await res.json()) === null) goToLogin(loginHref);
      } catch {
        // Offline: the next round tries again.
      }
    };
    const timer = setInterval(() => void slide(), intervalMs);
    return () => clearInterval(timer);
  }, [loginHref, intervalMs]);
}

/**
 * The visual viewport's height on a phone: the soft keyboard shrinks it (iOS keeps the layout
 * viewport), so the pane and the key bar stay above the keyboard.
 */
export function useVisualViewportHeight(enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) {
      setHeight(null);
      return;
    }
    const update = (): void => setHeight(Math.round(viewport.height));
    update();
    viewport.addEventListener('resize', update);
    return () => viewport.removeEventListener('resize', update);
  }, [enabled]);
  return height;
}

/** A best guess of the grid a pane area holds, before any terminal measured it. */
export function estimateViewport(
  width: number,
  height: number,
  fontSize: number,
): { cols: number; rows: number } {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)));
  return {
    cols: clamp((width - 30) / (fontSize * 0.6), 20, 500),
    rows: clamp((height - 12) / (fontSize * 1.2), 5, 200),
  };
}

/** The session-creation viewport: what the daemon accepts (20–500 × 5–200, plan §5.5). */
export function clampCreateViewport(viewport: { cols: number; rows: number }): {
  cols: number;
  rows: number;
} {
  return {
    cols: Math.min(500, Math.max(20, Math.floor(viewport.cols))),
    rows: Math.min(200, Math.max(5, Math.floor(viewport.rows))),
  };
}
