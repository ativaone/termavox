import { describe, expect, it } from 'vitest';
import { safeReturnPath, withReturnPath } from '../lib/manage/return-to.ts';

describe('safeReturnPath', () => {
  it('keeps the allowed in-app pages', () => {
    for (const path of [
      '/workspace',
      '/servers',
      '/servers/new',
      '/servers/0199f1c2-7a4b-7c3d-9e8f-0123456789ab',
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
      '/servers/../admin',
      '/servers/a/b',
      '/servers/new?duplicate=1',
      // The pre-D-29 pages are gone, so they are no longer a way back.
      '/hosts',
      '/hosts/new',
      '/hosts/0199f1c2-7a4b-7c3d-9e8f-0123456789ab',
      '/admin/users',
      '/settings/account',
    ]) {
      expect(safeReturnPath(raw)).toBeNull();
    }
  });
});

describe('withReturnPath', () => {
  it('attaches an allowed origin, encoded', () => {
    expect(withReturnPath('/servers/new', '/workspace')).toBe('/servers/new?from=%2Fworkspace');
    expect(withReturnPath('/credentials?x=1', '/servers')).toBe('/credentials?x=1&from=%2Fservers');
  });

  it('leaves the link alone for a disallowed or missing origin', () => {
    expect(withReturnPath('/servers/new', '//evil.example')).toBe('/servers/new');
    expect(withReturnPath('/servers/new', null)).toBe('/servers/new');
  });
});
