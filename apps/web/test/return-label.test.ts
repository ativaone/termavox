import { describe, expect, it } from 'vitest';
import { returnPageOf } from '../lib/manage/return-label.ts';
import { withReturnPath } from '../lib/manage/return-to.ts';
import { ROUTES, serverPath } from '../lib/routes.ts';

describe('return pages (plan D-27, D-29)', () => {
  it('names each allowed page the Back link can lead to', () => {
    expect(returnPageOf('/workspace')).toEqual({ page: 'workspace', href: '/workspace' });
    expect(returnPageOf('/servers')).toEqual({ page: 'servers', href: '/servers' });
    expect(returnPageOf('/servers/new')).toEqual({ page: 'addServer', href: '/servers/new' });
    expect(returnPageOf('/credentials')).toEqual({ page: 'credentials', href: '/credentials' });
    expect(returnPageOf('/servers/0199f1c2-7a4b-7c3d-9e8f-0123456789ab')).toEqual({
      page: 'server',
      href: '/servers/0199f1c2-7a4b-7c3d-9e8f-0123456789ab',
      serverId: '0199f1c2-7a4b-7c3d-9e8f-0123456789ab',
    });
  });

  it('drops whatever safeReturnPath drops', () => {
    for (const raw of [undefined, ['/workspace'], '//evil.example', '/workspace?x=1', '/hosts']) {
      expect(returnPageOf(raw)).toBeNull();
    }
  });

  it('round-trips the links the first-run panel and the server page build', () => {
    const firstRun = new URL(withReturnPath(ROUTES.addServer, ROUTES.workspace), 'http://x');
    expect(firstRun.pathname).toBe('/servers/new');
    expect(returnPageOf(firstRun.searchParams.get('from'))?.page).toBe('workspace');
    const serverId = '0199f1c2-7a4b-7c3d-9e8f-0123456789ab';
    const fromServer = new URL(
      withReturnPath(ROUTES.credentials, serverPath(serverId)),
      'http://x',
    );
    expect(fromServer.pathname).toBe('/credentials');
    expect(returnPageOf(fromServer.searchParams.get('from'))).toMatchObject({
      page: 'server',
      serverId,
    });
  });
});
