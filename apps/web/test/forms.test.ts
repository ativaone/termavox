import { describe, expect, it } from 'vitest';
import { hasControlChars, readProfileForm } from '../lib/manage/forms.ts';

function profileForm(fields: { startupCommand?: string; env?: Array<[string, string]> }): FormData {
  const form = new FormData();
  form.set('name', 'prod');
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

const issues = (form: FormData) => {
  const { parsed } = readProfileForm(form);
  return parsed.success
    ? {}
    : Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i.message]));
};

describe('profile form launch values (M1)', () => {
  it('rejects CR, LF, NUL and other C0 controls in the startup command and env values', () => {
    expect(hasControlChars('tab\tseparated')).toBe(false);
    for (const bad of ['a\nb', 'a\rb', 'a\0b', 'esc\x1b[31m', 'bell\x07']) {
      expect(hasControlChars(bad)).toBe(true);
      expect(issues(profileForm({ startupCommand: `echo ${bad} done` }))).toEqual({
        startupCommand: 'startupControl',
      });
      expect(issues(profileForm({ env: [['TD_X', bad]] }))).toEqual({ env: 'envValueControl' });
    }
  });

  it('accepts one plain line, tabs included, and trailing semicolons', () => {
    const form = profileForm({
      startupCommand: 'cd /srv;\texec tmux attach;',
      env: [['TD_X', 'a\tb;']],
    });
    const { parsed } = readProfileForm(form);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.startupCommand).toBe('cd /srv;\texec tmux attach;');
    expect(parsed.data?.env).toEqual([{ key: 'TD_X', value: 'a\tb;' }]);
  });
});
