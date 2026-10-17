import { describe, expect, it } from 'vitest';
import { safeReturnPath, withReturnPath } from '../lib/manage/return-to.ts';

describe('safeReturnPath', () => {
  it('keeps the allowed in-app pages', () => {
    for (const path of [
      '/workspace',
      '/hosts',
      '/hosts/new',
      '/hosts/0199f1c2-7a4b-7c3d-9e8f-0123456789ab',
      '/credentials',
    ]) {
      expect(safeReturnPath(path)).toBe(path);
    }
  });

  it('drops everything else', () => {
    for (const raw of [
      null,
      undefined,
      42,
      '',
      'workspace',
      '//evil.example',
      'https://evil.example/workspace',
      '/\\evil.example',
      '/workspace?x=1',
      '/workspace#top',
      '/hosts/../admin',
      '/hosts/a/b',
      '/admin/users',
      '/settings/account',
    ]) {
      expect(safeReturnPath(raw)).toBeNull();
    }
  });
});

describe('withReturnPath', () => {
  it('attaches an allowed origin, encoded', () => {
    expect(withReturnPath('/hosts/new', '/workspace')).toBe('/hosts/new?from=%2Fworkspace');
    expect(withReturnPath('/credentials?x=1', '/hosts')).toBe('/credentials?x=1&from=%2Fhosts');
  });

  it('leaves the link alone for a disallowed or missing origin', () => {
    expect(withReturnPath('/hosts/new', '//evil.example')).toBe('/hosts/new');
    expect(withReturnPath('/hosts/new', null)).toBe('/hosts/new');
  });
});
