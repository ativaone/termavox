'use client';

import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { type RefObject, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChannelState, TerminalChannel } from './channel.ts';
import type { ConnectionState, TermavoxConnection } from './connection.ts';
import { computeTerminalLayout, type Size, type TerminalLayout } from './layout.ts';
import type { Dimensions } from './types.ts';
import type { BrowserTerminal, LinkConfirm, TerminalAppearance } from './xterm.ts';

export interface UseTerminalChannelOptions {
  /** Rendering-only options (theme, fonts); compared by value, so inline objects are fine. */
  appearance?: TerminalAppearance;
  /** Called when a link in the output is clicked; resolve true to open it (new tab, noopener). */
  confirmLink?: LinkConfirm;
  onTitle?(title: string): void;
  onBell?(): void;
  /** Default `webgl`, with DOM fallback. Changing it recreates the terminal. */
  renderer?: 'webgl' | 'dom';
  /**
   * Apply `layout.scale` as a CSS transform (origin top-left) on the xterm element when the
   * session is larger than the container (passive attachment). Default true. Set false to
   * position the terminal yourself from `layout`.
   */
  applyScale?: boolean;
}

export interface UseTerminalChannelResult {
  state: ChannelState | null;
  /** Viewport and scale/letterbox suggestion; null until the container and font are measured. */
  layout: TerminalLayout | null;
  channel: TerminalChannel | null;
  terminal: Terminal | null;
  search: SearchAddon | null;
  /** The terminal could not be created (e.g. ChannelLimitError). */
  error: Error | null;
}

interface Instance {
  bundle: BrowserTerminal;
  channel: TerminalChannel;
}

interface Measured {
  container: Size;
  cell: Size | null;
  viewport: Dimensions | null;
  scrollbarWidth: number;
}

/** Used for the attach message when the container cannot be measured yet (corrected right after). */
const FALLBACK_VIEWPORT: Dimensions = { cols: 80, rows: 24 };
const noopSubscribe = (): (() => void) => () => {};
const nullSnapshot = (): null => null;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** The connection's observable state (sessions, prompts, status). */
export function useConnectionState(connection: TermavoxConnection): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
}

/**
 * Mounts an xterm terminal in `containerRef` (an empty element whose size the layout defines,
 * not its content) and mirrors `sessionId` into it over `connection`. Resizes of the container
 * are reported as the viewport (the terminal is only resized by the server); focusing the
 * terminal makes this pane the active attachment. Pass `sessionId = null` to detach.
 */
export function useTerminalChannel(
  connection: TermavoxConnection | null,
  sessionId: string | null,
  containerRef: RefObject<HTMLElement | null>,
  options: UseTerminalChannelOptions = {},
): UseTerminalChannelResult {
  const [instance, setInstance] = useState<Instance | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const renderer = options.renderer;
  const appearanceJson = JSON.stringify(options.appearance ?? {});
  const applyScale = options.applyScale ?? true;

  // Terminal + channel. The xterm module is loaded on the client only.
  useEffect(() => {
    const container = containerRef.current;
    if (!connection || !container) return;
    let cancelled = false;
    let created: Instance | null = null;
    import('./xterm.ts').then(
      ({ createBrowserTerminal }) => {
        if (cancelled) return;
        const bundle = createBrowserTerminal(container, {
          appearance: latest.current.appearance ?? {},
          confirmLink: (uri) => latest.current.confirmLink?.(uri) ?? false,
          ...(renderer ? { renderer } : {}),
        });
        try {
          const channel = connection.openChannel({
            terminal: bundle.terminal,
            onTitle: (title) => latest.current.onTitle?.(title),
            onBell: () => latest.current.onBell?.(),
          });
          created = { bundle, channel };
          setInstance(created);
          setError(null);
        } catch (err) {
          bundle.dispose();
          setError(toError(err));
        }
      },
      (err: unknown) => {
        if (!cancelled) setError(toError(err));
      },
    );
    return () => {
      cancelled = true;
      if (created) {
        created.channel.dispose();
        created.bundle.dispose();
      }
      setInstance(null);
      setMeasured(null);
    };
  }, [connection, containerRef, renderer]);

  // Attach / detach.
  useEffect(() => {
    if (!instance || !sessionId) return;
    const { bundle, channel } = instance;
    channel.attach(sessionId, bundle.proposeViewport() ?? FALLBACK_VIEWPORT);
    return () => channel.detach();
  }, [instance, sessionId]);

  // Appearance, and measuring: viewport reports on every container resize or font change.
  useEffect(() => {
    const container = containerRef.current;
    if (!instance || !container) return;
    const { bundle, channel } = instance;
    bundle.setAppearance(JSON.parse(appearanceJson) as TerminalAppearance);
    let active = true;
    const measure = (): void => {
      if (!active) return;
      const viewport = bundle.proposeViewport();
      if (viewport) channel.setViewport(viewport);
      setMeasured({
        container: { width: container.clientWidth, height: container.clientHeight },
        cell: bundle.cellSize(),
        viewport,
        scrollbarWidth: bundle.scrollbarWidth(),
      });
    };
    const observer = new ResizeObserver(measure); // delivers an initial observation
    observer.observe(container);
    // Web fonts may finish loading after the first measurement.
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [instance, containerRef, appearanceJson]);

  // Focus → this pane becomes the active attachment.
  useEffect(() => {
    const textarea = instance?.bundle.terminal.textarea;
    if (!instance || !textarea) return;
    const onFocus = (): void => instance.channel.activate();
    textarea.addEventListener('focus', onFocus);
    return () => textarea.removeEventListener('focus', onFocus);
  }, [instance]);

  const state = useSyncExternalStore(
    instance?.channel.subscribe ?? noopSubscribe,
    instance?.channel.getSnapshot ?? nullSnapshot,
    nullSnapshot,
  );
  const size = state?.size ?? null;
  const layout = useMemo(
    () =>
      measured?.cell
        ? computeTerminalLayout({
            container: measured.container,
            cell: measured.cell,
            session: size,
            viewport: measured.viewport,
            scrollbarWidth: measured.scrollbarWidth,
          })
        : null,
    [measured, size],
  );

  // Passive attachment larger than the container: scale the terminal down to fit.
  const scale = layout?.scale ?? 1;
  useEffect(() => {
    const element = instance?.bundle.terminal.element;
    if (!element || !applyScale) return;
    element.style.transformOrigin = '0 0';
    element.style.transform = scale < 1 ? `scale(${scale})` : '';
    return () => {
      element.style.transform = '';
      element.style.transformOrigin = '';
    };
  }, [instance, applyScale, scale]);

  return {
    state,
    layout,
    channel: instance?.channel ?? null,
    terminal: instance?.bundle.terminal ?? null,
    search: instance?.bundle.search ?? null,
    error,
  };
}
