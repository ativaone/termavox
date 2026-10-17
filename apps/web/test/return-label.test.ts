import { describe, expect, it } from 'vitest';
import { returnPageOf } from '../lib/manage/return-label.ts';
import { withReturnPath } from '../lib/manage/return-to.ts';
import { ROUTES } from '../lib/routes.ts';

describe('return pages (plan D-27)', () => {
  it('names each allowed page the Back link can lead to', () => {
    expect(returnPageOf('/workspace')).toEqual({ page: 'workspace', href: '/workspace' });
    expect(returnPageOf('/hosts')).toEqual({ page: 'hosts', href: '/hosts' });
    expect(returnPageOf('/hosts/new')).toEqual({ page: 'addServer', href: '/hosts/new' });
    expect(returnPageOf('/credentials')).toEqual({ page: 'credentials', href: '/credentials' });
    expect(returnPageOf('/hosts/0199f1c2-7a4b-7c3d-9e8f-0123456789ab')).toEqual({
      page: 'host',
      href: '/hosts/0199f1c2-7a4b-7c3d-9e8f-0123456789ab',
      hostId: '0199f1c2-7a4b-7c3d-9e8f-0123456789ab',
    });
  });

  it('drops whatever safeReturnPath drops', () => {
    for (const raw of [undefined, ['/workspace'], '//evil.example', '/workspace?x=1', '/admin']) {
      expect(returnPageOf(raw)).toBeNull();
    }
  });

  it('round-trips the links the first-run panel and the profile form build', () => {
    const firstRun = new URL(withReturnPath(ROUTES.addServer, ROUTES.workspace), 'http://x');
    expect(firstRun.pathname).toBe('/hosts/new');
    expect(returnPageOf(firstRun.searchParams.get('from'))?.page).toBe('workspace');
    const hostId = '0199f1c2-7a4b-7c3d-9e8f-0123456789ab';
    const fromHost = new URL(withReturnPath(ROUTES.credentials, `/hosts/${hostId}`), 'http://x');
    expect(fromHost.pathname).toBe('/credentials');
    expect(returnPageOf(fromHost.searchParams.get('from'))).toMatchObject({ page: 'host', hostId });
  });
});
