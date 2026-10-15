/**
 * Remote command and tmux command builders (plan §5.11 remote command rule, §6.3 launch).
 *
 * Quoting layers of the launch command:
 *   1. the user's login shell (sh, bash, zsh, fish, csh…) parses `exec sh -c '<script>'`;
 *   2. `sh` parses the script (POSIX);
 *   3. tmux receives its argv and splits commands on `;` arguments;
 *   4. tmux runs the pane command with `default-shell -c` (the user's $SHELL again).
 * Layers 1 and 4 may be fish or csh, so `shQuote` only emits constructs those shells read the
 * same way as POSIX sh (see shQuote), and remote scripts stay on one line.
 */

/** Session name inside every Termdock tmux server. */
export const TMUX_SESSION = 'main';

// Bare words: no leading `=` (zsh EQUALS expansion) or `%` (fish/csh job syntax).
const SAFE_WORD = /^[A-Za-z0-9_./-][A-Za-z0-9_@%+=:,./-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOCKET_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * Single-quote shell quoting that parses identically in POSIX sh, bash, zsh, fish and csh:
 * `'` becomes `'\''` and `\` becomes `'\\'` (fish treats `\\` and `\'` as escapes even inside
 * single quotes, so backslashes are never left inside the quotes). Safe words stay bare.
 * Newlines are rejected: csh cannot hold them inside quotes.
 */
export function shQuote(value: string): string {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new RangeError('shQuote: value must be a single line without NUL');
  }
  if (SAFE_WORD.test(value)) return value;
  let out = "'";
  for (const ch of value) {
    if (ch === "'") out += "'\\''";
    else if (ch === '\\') out += "'\\\\'";
    else out += ch;
  }
  out += "'";
  // Drop empty quote pairs produced at the edges ('' + \' + …).
  return out.replace(/^''(?=\\)/, '').replace(/(\\[\\'])''$/, '$1');
}

/** Wraps a one-line POSIX script as the remote command `exec sh -c '<script>'`. */
export function remoteCommand(script: string): string {
  return `exec sh -c ${shQuote(script)}`;
}

/**
 * Quotes one argument for the tmux command language (control-mode stdin): single quotes, or
 * double quotes with `\`, `"`, `$` and `~` escaped when the value contains a single quote.
 */
export function tmuxQuote(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new RangeError('tmuxQuote: value must be a single line');
  }
  if (value !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) && !value.startsWith('%')) {
    return value;
  }
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/[\\"$~]/g, (ch) => `\\${ch}`)}"`;
}

export type DefaultTerminal = 'tmux-256color' | 'screen-256color';

export interface LaunchOptions {
  /** Absolute tmux path from the probe (`tmux_path`). */
  tmuxPath: string;
  /** `td-<installationId[0:8]>-<tmuxToken>`. */
  socket: string;
  /** Concrete UTF-8 locale from the probe (`utf8_locale`), exported as LC_CTYPE. */
  locale: string;
  historyLimit: number;
  defaultTerminal: DefaultTerminal;
  cols: number;
  rows: number;
  /** Profile env vars, passed as `new-session -e KEY=VALUE`. */
  env?: Record<string, string>;
  /** Optional startup command run by the login shell (`$SHELL -lc '<startup>'`). */
  startupCommand?: string | null;
  /** Prefix with `systemd-run --user --scope --quiet` (plan §5.11 logind rules). */
  systemdRun?: boolean;
}

function assertAbsolutePath(path: string): void {
  if (!path.startsWith('/') || !SAFE_WORD.test(path)) {
    throw new RangeError(`invalid tmux path: ${path}`);
  }
}

function assertSocket(socket: string): void {
  if (!SOCKET_NAME.test(socket)) throw new RangeError(`invalid tmux socket name: ${socket}`);
}

function assertDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new RangeError(`invalid ${name}: ${value}`);
  }
}

/** The pane command: the user's login shell, with our tmux variables removed (plan §6.3). */
export function paneCommand(startupCommand?: string | null): string {
  const base = 'exec env -u TMUX -u TMUX_PANE "$SHELL" -l';
  return startupCommand ? `${base}c ${shQuote(startupCommand)}` : base;
}

/** The POSIX script that launches or attaches the control client (plan §6.3). */
export function launchScript(opts: LaunchOptions): string {
  assertAbsolutePath(opts.tmuxPath);
  assertSocket(opts.socket);
  assertDimension('cols', opts.cols);
  assertDimension('rows', opts.rows);
  if (!Number.isInteger(opts.historyLimit) || opts.historyLimit < 0) {
    throw new RangeError(`invalid history limit: ${opts.historyLimit}`);
  }
  if (!/^[A-Za-z0-9_.@-]+$/.test(opts.locale))
    throw new RangeError(`invalid locale: ${opts.locale}`);
  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (!ENV_KEY.test(key)) throw new RangeError(`invalid environment variable name: ${key}`);
    envArgs.push('-e', shQuote(`${key}=${value}`));
  }
  const tmux = opts.systemdRun
    ? `systemd-run --user --scope --quiet ${opts.tmuxPath}`
    : opts.tmuxPath;
  const commands = [
    'start-server',
    `set-option -g history-limit ${opts.historyLimit}`,
    `set-option -g default-terminal ${opts.defaultTerminal}`,
    'set-option -g aggressive-resize off',
    'set-option -g detach-on-destroy on',
    'set-option -g window-size latest',
    'set-option -g status off',
    [
      `new-session -A -s ${TMUX_SESSION} -x ${opts.cols} -y ${opts.rows}`,
      ...envArgs,
      shQuote(paneCommand(opts.startupCommand)),
    ].join(' '),
  ];
  return (
    `export LC_CTYPE=${opts.locale}; ` +
    `exec ${tmux} -u -L ${opts.socket} -f /dev/null -C ${commands.join(' \\; ')}`
  );
}

/** Remote command for an SSH exec channel (no PTY) that becomes the control client. */
export function launchCommand(opts: LaunchOptions): string {
  return remoteCommand(launchScript(opts));
}

/** Remote command whose exit status tells whether our session exists (0) or not (1). */
export function hasSessionCommand(opts: { tmuxPath: string; socket: string }): string {
  assertAbsolutePath(opts.tmuxPath);
  assertSocket(opts.socket);
  return remoteCommand(`exec ${opts.tmuxPath} -L ${opts.socket} has-session -t ${TMUX_SESSION}`);
}

// Control-mode commands (written to the control client's stdin, one per line).

export function refreshClientSize(cols: number, rows: number): string {
  assertDimension('cols', cols);
  assertDimension('rows', rows);
  return `refresh-client -C ${cols}x${rows}`;
}

export function refreshClientPauseAfter(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new RangeError(`pause-after must be an integer >= 1, got ${seconds}`);
  }
  return `refresh-client -f pause-after=${seconds}`;
}

export function refreshClientContinue(paneId: number): string {
  return `refresh-client -A '%${paneIdOf(paneId)}:continue'`;
}

export function killServer(): string {
  return 'kill-server';
}

export const LIST_CLIENTS_FORMAT = '#{client_name} #{client_control_mode} #{client_pid}';

export function listClients(): string {
  return `list-clients -F '${LIST_CLIENTS_FORMAT}'`;
}

export interface ListedClient {
  name: string;
  controlMode: boolean;
  pid: number;
}

/** Parses one `list-clients -F LIST_CLIENTS_FORMAT` line. */
export function parseListedClient(line: string): ListedClient | null {
  const match = /^(.*) ([01]) (\d+)$/.exec(line);
  if (!match) return null;
  return { name: match[1]!, controlMode: match[2] === '1', pid: Number(match[3]) };
}

export function detachClient(name: string): string {
  return `detach-client -t ${tmuxQuote(name)}`;
}

/** `display-message -p` printing a literal string (the batch sentinel). */
export function displayLiteral(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new RangeError(`unsafe literal: ${text}`);
  return `display-message -p '${text}'`;
}

function paneIdOf(paneId: number): number {
  if (!Number.isInteger(paneId) || paneId < 0) throw new RangeError(`invalid pane id: ${paneId}`);
  return paneId;
}
