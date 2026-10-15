/**
 * Terminal configuration shared by the server emulator (@xterm/headless) and the browser
 * (@xterm/xterm). Both sides MUST use the same xterm version, options and Unicode provider so
 * that identical bytes produce identical state (plan T-02).
 */
export const XTERM_VERSION = '6.0.0';
export const UNICODE_VERSION = '11';
export const DEFAULT_SCROLLBACK = 10_000;
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;

export * from './mode-tracker.ts';
export * from './utf8.ts';

/** Options that affect buffer state. Rendering-only options (fonts, theme) stay in the web app. */
export const sharedTerminalOptions = {
  allowProposedApi: true, // required by the unicode11 addon and parser hooks
  convertEol: false,
  scrollback: DEFAULT_SCROLLBACK,
} as const;

interface Disposable {
  dispose(): void;
}
type Params = (number | number[])[];
interface FunctionIdentifier {
  prefix?: string;
  intermediates?: string;
  final: string;
}

/** Structural subset of the xterm parser API, common to @xterm/xterm and @xterm/headless. */
export interface ParserHost {
  parser: {
    registerCsiHandler(id: FunctionIdentifier, cb: (params: Params) => boolean): Disposable;
    registerDcsHandler(
      id: FunctionIdentifier,
      cb: (data: string, params: Params) => boolean,
    ): Disposable;
    registerOscHandler(ident: number, cb: (data: string) => boolean): Disposable;
    registerEscHandler(id: FunctionIdentifier, cb: () => boolean): Disposable;
  };
}

const swallow = (): boolean => true;
/** xterm window-ops (CSI Ps t) values that request a report rather than change state. */
const WINDOW_REPORTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);

/**
 * Consumes terminal queries so this emulator never answers them (plan §5.3).
 * Applied in the browser always, and on the server when tmux answers (tmux-control).
 * Returns a disposable that restores default handling.
 *
 * xterm calls the most recently registered handler first, so install this after every addon
 * that registers parser handlers. An OSC 4/10/11/12 that mixes color sets with `?` queries is
 * swallowed whole (the sets are lost); applications send queries on their own in practice.
 * Coverage against xterm 6 is pinned by test/query-silencer.test.ts (ADR-0001).
 */
export function installQuerySilencer(term: ParserHost): Disposable {
  const p = term.parser;
  const disposables: Disposable[] = [
    p.registerCsiHandler({ final: 'c' }, swallow), // DA1
    p.registerCsiHandler({ prefix: '>', final: 'c' }, swallow), // DA2
    p.registerCsiHandler({ prefix: '=', final: 'c' }, swallow), // DA3
    p.registerCsiHandler({ final: 'n' }, swallow), // DSR / CPR
    p.registerCsiHandler({ prefix: '?', final: 'n' }, swallow), // DEC DSR (incl. ?996n)
    p.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow), // DECRQM (ANSI)
    p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow), // DECRQM (DEC)
    p.registerCsiHandler({ prefix: '>', final: 'q' }, swallow), // XTVERSION
    p.registerCsiHandler({ prefix: '?', final: 'u' }, swallow), // kitty keyboard query
    p.registerCsiHandler({ final: 't' }, (params) => WINDOW_REPORTS.has(Number(params[0] ?? 0))),
    p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow), // DECRQSS
    p.registerDcsHandler({ intermediates: '+', final: 'q' }, swallow), // XTGETTCAP
    ...[4, 10, 11, 12].map((ident) =>
      p.registerOscHandler(ident, (data) => data.split(';').includes('?')),
    ),
    // Clipboard read (OSC 52 ; Pc ; ?): not handled by xterm core, but answered with the
    // clipboard contents if the browser ever loads @xterm/addon-clipboard.
    p.registerOscHandler(52, (data) => data.split(';')[1] === '?'),
  ];
  return {
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}
