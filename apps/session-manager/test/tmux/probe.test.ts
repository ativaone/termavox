import { describe, expect, it } from 'vitest';
import {
  compareTmuxVersions,
  PROBE_SCRIPT,
  parseProbeOutput,
  parseTmuxVersion,
  probeCommand,
  tmuxVersionAtLeast,
} from '../../src/probe/index.ts';

describe('parseTmuxVersion', () => {
  it.each([
    ['tmux 3.4', { major: 3, minor: 4, patch: '', next: false, prerelease: false }],
    ['tmux 3.2a', { major: 3, minor: 2, patch: 'a', next: false }],
    ['3.4a', { major: 3, minor: 4, patch: 'a' }],
    ['tmux next-3.9', { major: 3, minor: 9, next: true }],
    ['tmux 3.3-rc', { major: 3, minor: 3, prerelease: true }],
    ['tmux 3.10', { major: 3, minor: 10 }],
    ['tmux master', { major: 3, minor: 8, next: true }],
    ['tmux openbsd-7.6', { major: 3, minor: 5, patch: '', approximate: true }],
    ['tmux openbsd-6.8', { major: 3, minor: 1, approximate: true }],
    ['tmux openbsd-9.9', { major: 3, minor: 5, patch: 'a', approximate: true }],
  ])('parses %s', (input, expected) => {
    expect(parseTmuxVersion(input)).toMatchObject(expected);
  });

  it('returns null for garbage', () => {
    expect(parseTmuxVersion('')).toBeNull();
    expect(parseTmuxVersion('tmux: command not found')).toBeNull();
  });

  it('orders versions for the plan §6.2 gates', () => {
    const order = ['2.7', '3.1c', '3.2-rc', '3.2', '3.2a', '3.3a', '3.4', 'next-3.4', '3.10'];
    const parsed = order.map((v) => parseTmuxVersion(v)!);
    for (let i = 1; i < parsed.length; i++) {
      expect(compareTmuxVersions(parsed[i - 1]!, parsed[i]!)).toBeLessThan(0);
    }
    const at = (v: string, major: number, minor: number) =>
      tmuxVersionAtLeast(parseTmuxVersion(v)!, major, minor);
    expect(at('3.2a', 3, 2)).toBe(true);
    expect(at('3.2-rc', 3, 2)).toBe(false);
    expect(at('next-3.7', 3, 7)).toBe(true);
    expect(at('openbsd-7.0', 3, 2)).toBe(true);
    expect(at('openbsd-6.8', 3, 2)).toBe(false);
  });
});

describe('probe', () => {
  it('is one line without csh history characters, wrapped as exec sh -c', () => {
    expect(PROBE_SCRIPT).not.toMatch(/[\n!]/);
    expect(probeCommand().startsWith("exec sh -c 'printf ")).toBe(true);
  });

  it('parses a full result and ignores rc-file noise and CRLF', () => {
    const result = parseProbeOutput(
      [
        'Welcome! (printed by .bashrc)',
        'shell=/usr/bin/zsh',
        'tmux_path=/usr/bin/tmux',
        'tmux_version=tmux 3.2a',
        'utf8_locale=C.utf8\r',
        'ti_tmux256=yes',
        'systemd_run=yes',
        'kill_user_processes=yes',
        'linger=no',
        '',
      ].join('\n'),
    );
    expect(result).toMatchObject({
      shell: '/usr/bin/zsh',
      tmuxPath: '/usr/bin/tmux',
      tmuxVersionRaw: 'tmux 3.2a',
      tmuxVersion: { major: 3, minor: 2, patch: 'a' },
      utf8Locale: 'C.utf8',
      tiTmux256: true,
      systemdRun: true,
      killUserProcesses: 'yes',
      linger: 'no',
    });
  });

  it('reports absent tmux, missing locale and unknown logind state', () => {
    const result = parseProbeOutput(
      'shell=/bin/bash\nutf8_locale=\nti_tmux256=no\nsystemd_run=no\nkill_user_processes=unknown\nlinger=unknown\n',
    );
    expect(result).toMatchObject({
      tmuxPath: null,
      tmuxVersion: null,
      utf8Locale: null,
      tiTmux256: false,
      systemdRun: false,
      killUserProcesses: 'unknown',
      linger: 'unknown',
    });
    // A relative tmux path (alias, function) is not usable for the launch.
    expect(parseProbeOutput('tmux_path=tmux\ntmux_version=tmux 3.4\n').tmuxPath).toBeNull();
  });
});
