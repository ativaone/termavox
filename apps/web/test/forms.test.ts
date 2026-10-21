import { describe, expect, it } from 'vitest';
import { hasControlChars, issuesOf, readServerForm, toServerInput } from '../lib/manage/forms.ts';

function serverForm(fields: { startupCommand?: string; env?: Array<[string, string]> }): FormData {
  const form = new FormData();
  form.set('name', 'prod');
  form.set('hostname', 'db.internal');
  form.set('port', '22');
  form.set('username', 'deploy');
  form.set('protectionMode', 'auto');
  form.set('keepaliveIntervalS', '15');
  form.set('scrollbackLines', '5000');
  if (fields.startupCommand !== undefined) form.set('startupCommand', fields.startupCommand);
  for (const [key, value] of fields.env ?? []) {
    form.append('envKey', key);
    form.append('envValue', value);
  }
  return form;
}

/** The first failing check per field, as the Server Actions report it. */
const issues = (form: FormData) => {
  const { parsed } = readServerForm(form);
  return parsed.success ? {} : issuesOf(parsed.error);
};

describe('server form launch values (M1)', () => {
  it('rejects CR, LF, NUL and other C0 controls in the startup command and env values', () => {
    expect(hasControlChars('tab\tseparated')).toBe(false);
    for (const bad of ['a\nb', 'a\rb', 'a\0b', 'esc\x1b[31m', 'bell\x07']) {
      expect(hasControlChars(bad)).toBe(true);
      expect(issues(serverForm({ startupCommand: `echo ${bad} done` }))).toEqual({
        startupCommand: 'startupControl',
      });
      expect(issues(serverForm({ env: [['TV_X', bad]] }))).toEqual({ env: 'envValueControl' });
    }
  });

  it('accepts one plain line, tabs included, and trailing semicolons', () => {
    const form = serverForm({
      startupCommand: 'cd /srv;\texec tmux attach;',
      env: [['TV_X', 'a\tb;']],
    });
    const { parsed } = readServerForm(form);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.startupCommand).toBe('cd /srv;\texec tmux attach;');
    expect(parsed.data?.env).toEqual([{ key: 'TV_X', value: 'a\tb;' }]);
  });
});

describe('server form terminal type (plan D-49)', () => {
  it('accepts Automatic and xterm-256color, and reads a missing one as Automatic', () => {
    for (const value of ['auto', 'xterm-256color'] as const) {
      const form = serverForm({});
      form.set('tmuxTerm', value);
      const { parsed, values } = readServerForm(form);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.tmuxTerm).toBe(value);
      expect(values.tmuxTerm).toBe(value);
      expect(toServerInput(parsed.data, null).tmuxTerm).toBe(value);
    }
    const { parsed, values } = readServerForm(serverForm({}));
    expect(parsed.data?.tmuxTerm).toBe('auto');
    expect(values.tmuxTerm).toBe('auto');
  });

  it('refuses any other value instead of guessing, and echoes it back', () => {
    for (const bad of ['tmux-256color', 'screen-256color', 'XTERM-256COLOR', 'vt100', 'xterm']) {
      const form = serverForm({});
      form.set('tmuxTerm', bad);
      expect(issues(form)).toEqual({ tmuxTerm: 'tmuxTerm' });
      expect(readServerForm(form).values.tmuxTerm).toBe(bad);
    }
  });
});

describe('server form target (plan D-29)', () => {
  it('needs an address, a port and a user name for SSH', () => {
    const form = serverForm({});
    form.set('hostname', '');
    form.set('port', '0');
    form.set('username', 'two words');
    expect(issues(form)).toEqual({
      hostname: 'hostnameRequired',
      port: 'port',
      username: 'username',
    });
  });

  it('stores no address, user name or credential for a local server', () => {
    const form = serverForm({});
    form.set('kind', 'local');
    const { parsed } = readServerForm(form);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      kind: 'local',
      hostname: null,
      port: null,
      username: null,
    });
    expect(toServerInput(parsed.data, 'some-credential').credentialId).toBeNull();
  });
});
