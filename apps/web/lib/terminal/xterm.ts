/**
 * Browser terminal factory (client-only: import it dynamically so server rendering never
 * evaluates @xterm/xterm). Builds the pinned @xterm/xterm Terminal exactly like the server
 * emulator for everything that affects buffer state (ADR-0001): `sharedTerminalOptions`,
 * Unicode 11 active, and the query silencer installed after every addon. Appearance options
 * (theme, fonts) come from the UI and never override state-affecting options.
 */
import {
  DEFAULT_SCROLLBACK,
  installQuerySilencer,
  sharedTerminalOptions,
  UNICODE_VERSION,
} from '@termdock/terminal-config';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { type ITerminalOptions, Terminal } from '@xterm/xterm';
import type { Size } from './layout.ts';
import type { Dimensions, Disposable } from './types.ts';

/** Rendering-only options the UI may set. Cursor style/blink are terminal state, not listed. */
export type TerminalAppearance = Pick<
  ITerminalOptions,
  | 'theme'
  | 'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'fontWeightBold'
  | 'lineHeight'
  | 'letterSpacing'
  | 'cursorInactiveStyle'
  | 'minimumContrastRatio'
  | 'drawBoldTextInBrightColors'
>;

/** Decides whether a clicked link opens (the UI shows its confirmation). */
export type LinkConfirm = (uri: string) => boolean | Promise<boolean>;

export interface BrowserTerminalOptions {
  appearance?: TerminalAppearance;
  /** Without it, links are underlined but never opened. */
  confirmLink?: LinkConfirm;
  /** `webgl` (default) falls back to the DOM renderer when WebGL is unavailable or lost. */
  renderer?: 'webgl' | 'dom';
}

export interface BrowserTerminal extends Disposable {
  readonly terminal: Terminal;
  readonly fit: FitAddon;
  readonly search: SearchAddon;
  /** The fitted viewport of the container (never applied locally: the server sizes sessions). */
  proposeViewport(): Dimensions | null;
  /** CSS size of one cell, or null before the renderer measured the font. */
  cellSize(): Size | null;
  /** Horizontal space reserved for the scrollbar (CSS px). */
  scrollbarWidth(): number;
  setAppearance(appearance: TerminalAppearance): void;
}

/** xterm 6 ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH (what FitAddon subtracts). */
const DEFAULT_SCROLL_BAR_WIDTH = 14;

/** Private render dimensions, the same field FitAddon reads (pinned by XTERM_VERSION). */
interface RenderInternals {
  _core?: { _renderService?: { dimensions?: { css?: { cell?: Size } } } };
}

function openLink(uri: string, confirm: LinkConfirm | undefined): void {
  if (!confirm || !/^https?:\/\//i.test(uri)) return;
  void Promise.resolve(confirm(uri)).then(
    (ok) => {
      if (ok) window.open(uri, '_blank', 'noopener,noreferrer');
    },
    () => {},
  );
}

/** Creates the terminal inside `container` (which should be empty and sized by the layout). */
export function createBrowserTerminal(
  container: HTMLElement,
  options: BrowserTerminalOptions = {},
): BrowserTerminal {
  const terminal = new Terminal({
    ...options.appearance,
    ...sharedTerminalOptions,
    // Resized to the session's scrollbackLines when `session.attached` arrives.
    scrollback: DEFAULT_SCROLLBACK,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = UNICODE_VERSION;
  terminal.open(container);
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri, options.confirmLink)));
  const search = new SearchAddon();
  terminal.loadAddon(search);
  let webgl: WebglAddon | null = null;
  if (options.renderer !== 'dom') {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose(); // xterm falls back to the DOM renderer
        if (webgl === addon) webgl = null;
      });
      terminal.loadAddon(addon);
      webgl = addon;
    } catch {
      webgl = null; // no WebGL2: DOM renderer
    }
  }
  // Last: xterm calls the most recently registered parser handler first (plan §5.3).
  const silencer = installQuerySilencer(terminal);

  return {
    terminal,
    fit,
    search,
    proposeViewport() {
      const dims = fit.proposeDimensions();
      return dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)
        ? { cols: dims.cols, rows: dims.rows }
        : null;
    },
    cellSize() {
      const cell = (terminal as unknown as RenderInternals)._core?._renderService?.dimensions?.css
        ?.cell;
      return cell && cell.width > 0 && cell.height > 0
        ? { width: cell.width, height: cell.height }
        : null;
    },
    scrollbarWidth() {
      return terminal.options.scrollback === 0
        ? 0
        : terminal.options.overviewRuler?.width || DEFAULT_SCROLL_BAR_WIDTH;
    },
    setAppearance(appearance) {
      Object.assign(terminal.options, appearance);
    },
    dispose() {
      silencer.dispose();
      webgl?.dispose();
      terminal.dispose();
    },
  };
}
