/**
 * Remote command and tmux command builders (plan §5.11 remote command rule, §6.3 launch).
 *
 * Quoting layers of the launch command:
 *   1. the user's login shell (sh, bash, zsh, fish, csh…) parses `exec sh -c '<script>'`;
 *   2. `sh` parses the script (POSIX);
 *   3. tmux receives its argv and splits commands on `;` arguments (see tmuxArg);
 *   4. tmux runs the pane command with `default-shell -c` (the user's $SHELL again).
 * Layers 1 and 4 may be fish or csh, so `shQuote` only emits constructs those shells read the
 * same way as POSIX sh (see shQuote), and remote scripts stay on one line.
 *
 * A value the builders cannot pass safely throws BadLaunchParamsError (a RangeError): the
 * runtime fails the session instead of reconnecting, since a retry would only repeat it.
 */
import type { TmuxTerm } from '@termavox/protocol';
import { BadLaunchParamsError } from '../../core/types.ts';

/** Session name inside every Termavox tmux server. */
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
    throw new BadLaunchParamsError('shQuote: value must be a single line without NUL');
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

/** The pane's terminal type, tmux's `default-terminal` (plan §6.3). */
export type DefaultTerminal = 'tmux-256color' | 'screen-256color' | 'xterm-256color';

/**
 * The pane's terminal type for a session (plan §6.3, D-49): `xterm-256color` when its server asks
 * for it, else tmux's own type, as tmux recommends: `tmux-256color` when the probe found its
 * terminfo, else `screen-256color`.
 */
export function defaultTerminalFor(tmuxTerm: TmuxTerm, tiTmux256: boolean): DefaultTerminal {
  if (tmuxTerm === 'xterm-256color') return 'xterm-256color';
  return tiTmux256 ? 'tmux-256color' : 'screen-256color';
}

export interface LaunchOptions {
  /** Absolute tmux path from the probe (`tmux_path`). */
  tmuxPath: string;
  /** `tv-<installationId[0:8]>-<tmuxToken>`. */
  socket: string;
  /** Concrete UTF-8 locale from the probe (`utf8_locale`), exported as LC_CTYPE. */
  locale: string;
  historyLimit: number;
  defaultTerminal: DefaultTerminal;
  cols: number;
  rows: number;
  /**
   * Server env vars, passed as `new-session -e KEY=VALUE`, after `COLORTERM=truecolor` unless
   * they set COLORTERM themselves (plan D-49).
   */
  env?: Record<string, string>;
  /** Optional startup command run by the login shell (`$SHELL -lc '<startup>'`). */
  startupCommand?: string | null;
  /** Prefix with `systemd-run --user --scope --quiet` (plan §5.11 logind rules). */
  systemdRun?: boolean;
}

function assertAbsolutePath(path: string): void {
  if (!path.startsWith('/') || !SAFE_WORD.test(path)) {
    throw new BadLaunchParamsError(`invalid tmux path: ${path}`);
  }
}

function assertSocket(socket: string): void {
  if (!SOCKET_NAME.test(socket)) {
    throw new BadLaunchParamsError(`invalid tmux socket name: ${socket}`);
  }
}

function assertDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new RangeError(`invalid ${name}: ${value}`);
  }
}

/**
 * One argument of the launch argv as tmux must receive it (layer 3). tmux ends a command at any
 * argument whose last character is `;`, unless it ends in `\;`, which tmux turns into `;`. So a
 * trailing `;` gets a backslash in front that tmux consumes: the values `a;` and `a\;` are sent
 * as `a\;` and `a\\;` and arrive unchanged.
 */
export function tmuxArg(value: string): string {
  return value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;
}

/** The pane command: the user's login shell, with our tmux variables removed (plan §6.3). */
export function paneCommand(startupCommand?: string | null): string {
  const base = 'exec env -u TMUX -u TMUX_PANE "$SHELL" -l';
  return startupCommand ? `${base}c ${shQuote(startupCommand)}` : base;
}

/**
 * Printed by `new-session -P` only when it created the session; when `-A` attaches to an
 * existing one, tmux returns before printing (ADR-0003). The marker lands in the reply block of
 * the last launch command.
 */
export const SESSION_CREATED_MARKER = 'tv-created';

/**
 * The tmux commands of the launch argv, in order. Each one answers with its own flags-0 block,
 * so the launch is complete when `launchCommands(opts).length` such blocks have ended.
 */
export function launchCommands(opts: LaunchOptions): string[] {
  if (!Number.isInteger(opts.historyLimit) || opts.historyLimit < 0) {
    throw new BadLaunchParamsError(`invalid history limit: ${opts.historyLimit}`);
  }
  assertDimension('cols', opts.cols);
  assertDimension('rows', opts.rows);
  const env = opts.env ?? {};
  const envArgs: string[] = [];
  // Protected sessions declare 24-bit color (plan D-49): tmux keeps it and so does the browser.
  // A COLORTERM in the server's environment wins, whatever its value, the empty one included.
  if (!Object.hasOwn(env, 'COLORTERM')) envArgs.push('-e', 'COLORTERM=truecolor');
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) {
      throw new BadLaunchParamsError(`invalid environment variable name: ${key}`);
    }
    envArgs.push('-e', shQuote(tmuxArg(`${key}=${value}`)));
  }
  return [
    'start-server',
    `set-option -g history-limit ${opts.historyLimit}`,
    `set-option -g default-terminal ${opts.defaultTerminal}`,
    'set-option -g aggressive-resize off',
    'set-option -g detach-on-destroy on',
    'set-option -g window-size latest',
    'set-option -g status off',
    // tmux >= 3.3: ED 2 and ED 0 at home clear without scrolling the screen into history, as
    // xterm.js does, so a rebuilt scrollback matches the live one. 3.2 lacks the option: -q
    // makes set-option ignore it (the block still ends with %end).
    'set-option -gqw scroll-on-clear off',
    [
      `new-session -A -P -F ${SESSION_CREATED_MARKER} -s ${TMUX_SESSION}`,
      `-x ${opts.cols} -y ${opts.rows}`,
      ...envArgs,
      shQuote(tmuxArg(paneCommand(opts.startupCommand))),
    ].join(' '),
  ];
}

/** The POSIX script that launches or attaches the control client (plan §6.3). */
export function launchScript(opts: LaunchOptions): string {
  assertAbsolutePath(opts.tmuxPath);
  assertSocket(opts.socket);
  if (!/^[A-Za-z0-9_.@-]+$/.test(opts.locale)) {
    throw new BadLaunchParamsError(`invalid locale: ${opts.locale}`);
  }
  const tmux = opts.systemdRun
    ? `systemd-run --user --scope --quiet ${opts.tmuxPath}`
    : opts.tmuxPath;
  return (
    `export LC_CTYPE=${opts.locale}; ` +
    `exec ${tmux} -u -L ${opts.socket} -f /dev/null -C ${launchCommands(opts).join(' \\; ')}`
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

/**
 * Shell fragments of the remote scripts (`t` = tmux path, `s` = socket name).
 *
 * SOCKET_PROCESSES lists the tmux processes of our socket (server and clients): the first word
 * of the command line names the tmux binary (Alpine shows `{tmux: server} /usr/bin/tmux …`), so a
 * shell whose command line merely mentions the socket never matches, and the socket name only
 * appears as `$s` in our own scripts. The trailing space keeps `tv-x-ab` from matching
 * `tv-x-abc` (our argv always continues with `-f /dev/null`).
 *
 * A tmux server whose session ended still waits for every client to go, and a
 * control client whose output can no longer be written (its connection died with output queued)
 * never goes, on 3.2a, 3.4 and 3.8 alike: the server would outlive its session forever. So the
 * processes of our socket (server and clients; the socket is private to one session) get 1 s to
 * exit, then SIGKILL, and a socket file left by a killed server is removed.
 */
const SOCKET_PROCESSES = 'pgrep -u "$(id -u)" -f "^[^ ]*[t]mux[^ ]* .*-L $s "';
const WAIT_FOR_EXIT = `i=0; while p=$(${SOCKET_PROCESSES}); do [ $i -ge 10 ] && break; sleep 0.1; i=$((i+1)); done`;
const KILL_LEFTOVERS = `kill -9 $p 2>/dev/null; rm -f "\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$s"`;
/** tmux recreates its socket file on SIGUSR1 but not the directory: a purged one comes first. */
const ENSURE_SOCKET_DIR = `d="\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"; [ -d "$d" ] || mkdir -m 700 "$d"`;

/**
 * Remote command run before a reattach (plan §6.10, deleted socket). Exit status:
 *   0  our server answers;
 *   1  it does not and no tmux process for our socket runs (remote reboot, or the session ended);
 *   2  a process for our socket still ran (its socket file was deleted): SIGUSR1 made tmux
 *      recreate the socket and the server answers again;
 *   3  signalled, but the server still does not answer.
 */
export function recoverSocketCommand(opts: { tmuxPath: string; socket: string }): string {
  assertAbsolutePath(opts.tmuxPath);
  assertSocket(opts.socket);
  const answers = `"$t" -L "$s" has-session -t ${TMUX_SESSION} 2>/dev/null`;
  return remoteCommand(
    `t=${opts.tmuxPath}; s=${opts.socket}; ${answers} && exit 0; ` +
      `p=$(${SOCKET_PROCESSES}) || exit 1; ` +
      `${ENSURE_SOCKET_DIR}; kill -USR1 $p; i=0; ` +
      `while [ $i -lt 20 ]; do ${answers} && exit 2; sleep 0.1; i=$((i+1)); done; exit 3`,
  );
}

/**
 * Remote command confirming that our session ended (`%exit`, or the control channel closed;
 * plan §6.10). Exit status 0: the session lives. 1: it is gone and no tmux process of our socket
 * is left. A server process that does not answer had its socket (or the socket directory)
 * deleted: SIGUSR1 recreates it and the session may still be there (0). Leftovers are killed
 * (see SOCKET_PROCESSES).
 */
export function confirmEndedCommand(opts: { tmuxPath: string; socket: string }): string {
  assertAbsolutePath(opts.tmuxPath);
  assertSocket(opts.socket);
  const answers = `"$t" -L "$s" has-session -t ${TMUX_SESSION} 2>/dev/null`;
  return remoteCommand(
    `t=${opts.tmuxPath}; s=${opts.socket}; ${answers} && exit 0; ${WAIT_FOR_EXIT}; ` +
      `[ -n "$p" ] || exit 1; ` +
      `if ! "$t" -L "$s" list-sessions >/dev/null 2>&1; then ${ENSURE_SOCKET_DIR}; ` +
      `kill -USR1 $p 2>/dev/null; ` +
      `j=0; while [ $j -lt 10 ]; do ${answers} && exit 0; sleep 0.1; j=$((j+1)); done; fi; ` +
      `${KILL_LEFTOVERS}; exit 1`,
  );
}

/**
 * Remote command that kills our tmux server (terminate), then any process of our socket that
 * keeps it from exiting (see SOCKET_PROCESSES). Always exits 0.
 */
export function killServerCommand(opts: { tmuxPath: string; socket: string }): string {
  assertAbsolutePath(opts.tmuxPath);
  assertSocket(opts.socket);
  return remoteCommand(
    `t=${opts.tmuxPath}; s=${opts.socket}; "$t" -L "$s" kill-server 2>/dev/null; ` +
      `${WAIT_FOR_EXIT}; [ -z "$p" ] || { ${KILL_LEFTOVERS}; }; exit 0`,
  );
}

/**
 * What the leftover scan reports of one tmux server after its socket name (plan D-30): `1` when
 * the session is `main` (so no session name leaves the host), then `session_created`,
 * `session_activity` (epoch seconds) and `session_attached` (clients). Numbers only: no pane
 * command, title or other host text is read.
 */
export const SCAN_SESSION_FORMAT =
  '#{?#{==:#{session_name},main},1,0} #{session_created} #{session_activity} #{session_attached}';
/** Answering servers one scan reports at most; the script prints one more to show the cut. */
export const SCAN_MAX_SERVERS = 200;

/**
 * Remote command listing this user's Termavox tmux servers (plan D-30): every socket file
 * `${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/tv-*` whose server answers `list-sessions` gives one line
 * `<socket>\t<created>\t<activity>\t<attached>` for its `main` session, or its first session if
 * there is no `main`. A name with anything outside [a-z0-9-] is skipped (it could break the line
 * format), and so is a socket whose server does not answer. Nothing is started, killed or
 * removed: `list-sessions` never starts a server. Stops after SCAN_MAX_SERVERS + 1 lines; always
 * exits 0. Run without a PTY, like every remote command (§5.11).
 */
export function scanSocketsCommand(opts: { tmuxPath: string }): string {
  assertAbsolutePath(opts.tmuxPath);
  return remoteCommand(
    `t=${opts.tmuxPath}; d="\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"; [ -d "$d" ] || exit 0; n=0; ` +
      `for f in "$d"/tv-*; do [ -S "$f" ] || continue; s=\${f##*/}; ` +
      `expr "x$s" : 'x[a-z0-9-]*$' >/dev/null || continue; ` +
      `l=$("$t" -L "$s" list-sessions -F '${SCAN_SESSION_FORMAT}' 2>/dev/null) || continue; ` +
      `m=$(printf '%s\\n' "$l" | grep '^1 ' | head -n 1); ` +
      `[ -n "$m" ] || m=$(printf '%s\\n' "$l" | head -n 1); [ -n "$m" ] || continue; ` +
      `set -f; set -- $m; set +f; printf '%s\\t%s\\t%s\\t%s\\n' "$s" "$2" "$3" "$4"; ` +
      `n=$((n+1)); [ $n -gt ${SCAN_MAX_SERVERS} ] && break; done; exit 0`,
  );
}

/** Remote command whose exit status tells whether the tmux server of `socket` answers (0). */
export function serverAnswersCommand(opts: { tmuxPath: string; socket: string }): string {
  assertAbsolutePath(opts.tmuxPath);
  assertSocket(opts.socket);
  return remoteCommand(
    `exec ${opts.tmuxPath} -L ${opts.socket} list-sessions -F x >/dev/null 2>&1`,
  );
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

/**
 * `display-message -p` expanding a tmux format, optionally for a pane. display-message passes
 * its template through strftime first (ADR-0002), so `%` is rejected; so are quotes and line
 * breaks. TABs are allowed (field separators).
 */
export function displayFormat(format: string, paneId?: number): string {
  if (format === '' || /[%'\r\n]/.test(format)) throw new RangeError(`unsafe format: ${format}`);
  const target = paneId === undefined ? '' : `-t %${paneIdOf(paneId)} `;
  return `display-message -p ${target}'${format}'`;
}

/** Leaves copy mode or any other pane mode before input is delivered (plan §6.5). */
export function sendKeysCancel(paneId: number): string {
  return `send-keys -X -t %${paneIdOf(paneId)} cancel`;
}

function paneIdOf(paneId: number): number {
  if (!Number.isInteger(paneId) || paneId < 0) throw new RangeError(`invalid pane id: ${paneId}`);
  return paneId;
}
