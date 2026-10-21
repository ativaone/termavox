import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BadLaunchParamsError } from '../../src/core/types.ts';
import {
  defaultTerminalFor,
  detachClient,
  hasSessionCommand,
  type LaunchOptions,
  launchCommand,
  launchCommands,
  launchScript,
  listClients,
  paneCommand,
  parseListedClient,
  refreshClientContinue,
  refreshClientPauseAfter,
  refreshClientSize,
  remoteCommand,
  shQuote,
  tmuxArg,
  tmuxQuote,
} from '../../src/drivers/tmux-control/index.ts';

const TRICKY = [
  '',
  'plain',
  'with space',
  "it's",
  "'",
  "''",
  '\\',
  "\\'",
  'a\\\\b',
  '$HOME `id` $(id) "q" ; & | > < * ? [a] {b,c} ~ # % !x',
  '=zsh-equals',
  '%job',
  'tab\there',
  'é中😀',
];

/** Runs `script` with `sh -c` on this machine (a stand-in for the remote login shell). */
function sh(script: string, env: Record<string, string> = {}): string {
  const result = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`sh failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

const work = mkdtempSync(join(tmpdir(), 'tv-commands-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A fake executable that prints its argv NUL-separated. */
function fakeArgvPrinter(name: string): string {
  const path = join(work, name);
  writeFileSync(path, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done\n');
  chmodSync(path, 0o755);
  return path;
}

const argvOf = (out: string): string[] => out.split('\0').slice(0, -1);

/**
 * tmux's own split of its argv into commands (cmd_parse_from_arguments, 3.2a to 3.8): an
 * argument ending in `;` ends the command, unless it ends in `\;`, which becomes `;`.
 */
function tmuxCommands(argv: string[]): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  for (const arg of argv) {
    if (!arg.endsWith(';')) {
      current.push(arg);
      continue;
    }
    const body = arg.slice(0, -1);
    if (body.endsWith('\\')) {
      current.push(`${body.slice(0, -1)};`);
      continue;
    }
    if (body !== '') current.push(body);
    commands.push(current);
    current = [];
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

const LAUNCH: LaunchOptions = {
  tmuxPath: '/usr/bin/tmux',
  socket: 'tv-1a2b3c4d-k3j9x2m8q0wz',
  locale: 'C.UTF-8',
  historyLimit: 10000,
  defaultTerminal: 'tmux-256color',
  cols: 120,
  rows: 40,
  env: { EDITOR: 'vim' },
};

describe('shQuote', () => {
  it.each(TRICKY)('round-trips %j through sh', (value) => {
    expect(argvOf(sh(`printf '%s\\0' ${shQuote(value)}`))).toEqual([value]);
  });

  it('never leaves a backslash inside single quotes (fish) and rejects newlines (csh)', () => {
    const backslashInsideQuotes = (quoted: string): boolean => {
      let inside = false;
      for (let i = 0; i < quoted.length; i++) {
        const ch = quoted[i];
        if (ch === "'") inside = !inside;
        else if (ch === '\\' && inside) return true;
        else if (ch === '\\') i++; // escaped character outside quotes
      }
      return false;
    };
    for (const value of TRICKY) expect(backslashInsideQuotes(shQuote(value))).toBe(false);
    expect(() => shQuote('a\nb')).toThrow(RangeError);
    expect(shQuote('safe-word_1.2/x')).toBe('safe-word_1.2/x');
  });

  it('wraps remote scripts as exec sh -c', () => {
    expect(remoteCommand("echo 'x'")).toBe("exec sh -c 'echo '\\''x'\\'");
    expect(sh(remoteCommand("printf '%s' \"$0\"; printf ' %s' ok"))).toBe('sh ok');
  });
});

describe('launch command', () => {
  it('produces the documented script', () => {
    expect(launchScript(LAUNCH)).toBe(
      'export LC_CTYPE=C.UTF-8; exec /usr/bin/tmux -u -L tv-1a2b3c4d-k3j9x2m8q0wz -f /dev/null -C ' +
        'start-server \\; set-option -g history-limit 10000 \\; ' +
        'set-option -g default-terminal tmux-256color \\; set-option -g aggressive-resize off \\; ' +
        'set-option -g detach-on-destroy on \\; set-option -g window-size latest \\; ' +
        'set-option -g status off \\; set-option -gqw scroll-on-clear off \\; ' +
        'new-session -A -P -F tv-created -s main -x 120 -y 40 -e COLORTERM=truecolor ' +
        '-e EDITOR=vim ' +
        '\'exec env -u TMUX -u TMUX_PANE "$SHELL" -l\'',
    );
    expect(launchCommands(LAUNCH)).toHaveLength(9); // one flags-0 reply block each
  });

  it('delivers the exact argv to tmux through the login shell and sh layers', () => {
    const startup = "printf '%s\\n' \"$HOME\" 'it'\\''s'";
    const command = launchCommand({
      ...LAUNCH,
      tmuxPath: fakeArgvPrinter('tmux'),
      env: { EDITOR: 'vim', TV_X: "a 'b' \\c $d" },
      startupCommand: startup,
    });
    expect(argvOf(sh(command))).toEqual([
      ...['-u', '-L', LAUNCH.socket, '-f', '/dev/null', '-C', 'start-server', ';'],
      ...['set-option', '-g', 'history-limit', '10000', ';'],
      ...['set-option', '-g', 'default-terminal', 'tmux-256color', ';'],
      ...['set-option', '-g', 'aggressive-resize', 'off', ';'],
      ...['set-option', '-g', 'detach-on-destroy', 'on', ';'],
      ...['set-option', '-g', 'window-size', 'latest', ';'],
      ...['set-option', '-g', 'status', 'off', ';'],
      ...['set-option', '-gqw', 'scroll-on-clear', 'off', ';'],
      ...['new-session', '-A', '-P', '-F', 'tv-created', '-s', 'main', '-x', '120', '-y', '40'],
      ...['-e', 'COLORTERM=truecolor', '-e', 'EDITOR=vim', '-e', "TV_X=a 'b' \\c $d"],
      // The pane command reaches tmux as ONE argument (else tmux would exec `exec` as a program).
      `exec env -u TMUX -u TMUX_PANE "$SHELL" -lc ${shQuote(startup)}`,
    ]);
  });

  it('runs the startup command verbatim in the user shell (pane command layer)', () => {
    const fakeShell = fakeArgvPrinter('fake-shell');
    const startup = "printf '%s\\n' \"$HOME\" 'it'\\''s' \\x";
    const argv = argvOf(sh(paneCommand(startup), { SHELL: fakeShell, TMUX: 'x', TMUX_PANE: '%1' }));
    expect(argv).toEqual(['-lc', startup]);
    expect(argvOf(sh(paneCommand(null), { SHELL: fakeShell }))).toEqual(['-l']);
  });

  it('exports the locale and can escape the logind session with systemd-run', () => {
    const script = launchScript({ ...LAUNCH, env: {}, systemdRun: true });
    expect(script).toContain('exec systemd-run --user --scope --quiet /usr/bin/tmux -u -L ');
    expect(script.startsWith('export LC_CTYPE=C.UTF-8; ')).toBe(true);
    expect(launchScript({ ...LAUNCH, defaultTerminal: 'screen-256color' })).toContain(
      'set-option -g default-terminal screen-256color',
    );
  });

  it("sets the pane's terminal type: tmux's own unless the server asks for xterm-256color (D-49)", () => {
    expect(defaultTerminalFor('auto', true)).toBe('tmux-256color');
    expect(defaultTerminalFor('auto', false)).toBe('screen-256color');
    expect(defaultTerminalFor('xterm-256color', true)).toBe('xterm-256color');
    expect(defaultTerminalFor('xterm-256color', false)).toBe('xterm-256color');
    const argv = argvOf(
      sh(
        launchCommand({
          ...LAUNCH,
          tmuxPath: fakeArgvPrinter('tmux'),
          defaultTerminal: 'xterm-256color',
        }),
      ),
    );
    const setOptions = tmuxCommands(argv).filter((command) => command[0] === 'set-option');
    expect(setOptions).toContainEqual(['set-option', '-g', 'default-terminal', 'xterm-256color']);
  });

  it('declares COLORTERM=truecolor unless the server environment sets COLORTERM (D-49)', () => {
    const envValues = (env: Record<string, string> | undefined): string[] => {
      const argv = argvOf(sh(launchCommand({ ...LAUNCH, tmuxPath: fakeArgvPrinter('tmux'), env })));
      const newSession = tmuxCommands(argv).at(-1)!;
      return newSession.flatMap((arg, i) => (newSession[i - 1] === '-e' ? [arg] : []));
    };
    expect(envValues(undefined)).toEqual(['COLORTERM=truecolor']);
    expect(envValues({})).toEqual(['COLORTERM=truecolor']);
    expect(envValues({ EDITOR: 'vim' })).toEqual(['COLORTERM=truecolor', 'EDITOR=vim']);
    // The server's own value wins, whatever it is, the empty one included.
    expect(envValues({ COLORTERM: '24bit' })).toEqual(['COLORTERM=24bit']);
    expect(envValues({ COLORTERM: '' })).toEqual(['COLORTERM=']);
    // Names are case-sensitive: another variable.
    expect(envValues({ colorterm: 'x' })).toEqual(['COLORTERM=truecolor', 'colorterm=x']);
    // One reply block per command, as before.
    expect(launchCommands({ ...LAUNCH, env: {} })).toHaveLength(9);
  });

  it('rejects unsafe inputs instead of quoting them', () => {
    expect(() => launchScript({ ...LAUNCH, tmuxPath: 'tmux' })).toThrow(RangeError);
    expect(() => launchScript({ ...LAUNCH, tmuxPath: '/opt/my tmux' })).toThrow(RangeError);
    expect(() => launchScript({ ...LAUNCH, socket: 'TV;rm' })).toThrow(RangeError);
    expect(() => launchScript({ ...LAUNCH, locale: "C.UTF-8'" })).toThrow(RangeError);
    expect(() => launchScript({ ...LAUNCH, env: { 'BAD-KEY': 'x' } })).toThrow(RangeError);
    expect(() => launchScript({ ...LAUNCH, cols: 0 })).toThrow(RangeError);
    expect(() => launchScript({ ...LAUNCH, startupCommand: 'a\nb' })).toThrow(RangeError);
  });

  it('refuses profile and probe values with BadLaunchParamsError (non-retryable, M1)', () => {
    const refused: Array<Partial<LaunchOptions>> = [
      { startupCommand: 'a\nb' },
      { startupCommand: 'a\rb' },
      { env: { TV_X: 'line\nbreak' } },
      { env: { TV_X: 'nul\0byte' } },
      { env: { 'BAD-KEY': 'x' } },
      { tmuxPath: '/usr/bin/tmux;id' },
      { tmuxPath: 'relative/tmux' },
      { locale: 'C.UTF-8\nX' },
      { socket: 'TV;rm' },
    ];
    for (const value of refused) {
      expect(() => launchCommand({ ...LAUNCH, ...value })).toThrow(BadLaunchParamsError);
    }
    const error = (() => {
      try {
        launchCommand({ ...LAUNCH, env: { TV_X: 'a\nb' } });
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(RangeError);
    expect(error).toMatchObject({ code: 'BAD_LAUNCH_PARAMS' });
    // A bad dimension is not a launch parameter of the profile or the probe.
    expect(() => launchScript({ ...LAUNCH, cols: 0 })).not.toThrow(BadLaunchParamsError);
  });

  it('escapes a trailing `;` so tmux neither splits the command nor loses it (L8)', () => {
    expect(tmuxArg('plain')).toBe('plain');
    expect(tmuxArg('a;')).toBe('a\\;');
    expect(tmuxArg(';')).toBe('\\;');
    expect(tmuxArg('a\\;')).toBe('a\\\\;');
    expect(tmuxArg('a;b')).toBe('a;b');

    const env = { TV_SEMI: 'value;', TV_ESCAPED: 'x\\;', TV_BARE: ';', TV_MID: 'a;b' };
    const argv = argvOf(sh(launchCommand({ ...LAUNCH, tmuxPath: fakeArgvPrinter('tmux'), env })));
    const commands = tmuxCommands(argv);
    expect(commands).toHaveLength(launchCommands({ ...LAUNCH, env }).length);
    const newSession = commands.at(-1)!;
    expect(newSession[0]).toBe('new-session');
    const values = newSession.flatMap((arg, i) => (newSession[i - 1] === '-e' ? [arg] : []));
    expect(values).toEqual([
      'COLORTERM=truecolor',
      'TV_SEMI=value;',
      'TV_ESCAPED=x\\;',
      'TV_BARE=;',
      'TV_MID=a;b',
    ]);
    // The pane command stays one argument, untouched.
    expect(newSession.at(-1)).toBe('exec env -u TMUX -u TMUX_PANE "$SHELL" -l');
  });
});

describe('control commands', () => {
  it('builds the documented commands', () => {
    expect(hasSessionCommand(LAUNCH)).toBe(
      "exec sh -c 'exec /usr/bin/tmux -L tv-1a2b3c4d-k3j9x2m8q0wz has-session -t main'",
    );
    expect(refreshClientSize(100, 30)).toBe('refresh-client -C 100x30');
    expect(refreshClientPauseAfter(5)).toBe('refresh-client -f pause-after=5');
    expect(() => refreshClientPauseAfter(0)).toThrow(RangeError);
    expect(refreshClientContinue(3)).toBe("refresh-client -A '%3:continue'");
    expect(listClients()).toBe(
      "list-clients -F '#{client_name} #{client_control_mode} #{client_pid}'",
    );
    expect(detachClient('client-107')).toBe('detach-client -t client-107');
    expect(detachClient('/dev/pts/3')).toBe('detach-client -t /dev/pts/3');
  });

  it('quotes tmux arguments and parses list-clients lines', () => {
    expect(tmuxQuote('a b')).toBe("'a b'");
    expect(tmuxQuote('%3')).toBe("'%3'");
    expect(tmuxQuote(`it's $x "y" \\`)).toBe(`"it's \\$x \\"y\\" \\\\"`);
    expect(parseListedClient('client-107 1 107')).toEqual({
      name: 'client-107',
      controlMode: true,
      pid: 107,
    });
    expect(parseListedClient('/dev/pts/1 0 88')).toEqual({
      name: '/dev/pts/1',
      controlMode: false,
      pid: 88,
    });
    expect(parseListedClient('garbage')).toBeNull();
  });
});
