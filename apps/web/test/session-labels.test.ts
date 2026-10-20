import { describe, expect, it } from 'vitest';
import { sessionLabels } from '../lib/sessions/live.ts';
import type { BaySession, SessionLabel } from '../lib/sessions/types.ts';

const bay = (id: string, label: string, status: BaySession['status']): BaySession => ({
  id,
  label,
  status,
  protection: null,
  kind: 'ssh',
  username: 'tv',
  hostname: 'box',
  port: 22,
  serverDeleted: false,
  createdAt: 1,
  endedAt: null,
});

describe('tab and pane labels', () => {
  const server = [bay('a', 'Deploy watcher', 'connected'), bay('b', 'Log tail', 'reconnecting')];

  it('use the server-rendered bay until the live list arrives (a WebSocket that never connects)', () => {
    const labels = sessionLabels(new Map(), false, server);
    expect(labels.get('a')).toEqual({ label: 'Deploy watcher', status: 'connected' });
    expect(labels.get('b')).toEqual({ label: 'Log tail', status: 'reconnecting' });
    expect(labels.get('unknown')).toBeUndefined(); // the placeholder stays for unknown ids
  });

  it('prefer a live entry over the first paint', () => {
    const live = new Map<string, SessionLabel>([['a', { label: 'Renamed', status: 'restoring' }]]);
    expect(sessionLabels(live, false, server).get('a')).toEqual({
      label: 'Renamed',
      status: 'restoring',
    });
  });

  it('use only the live list once it has arrived', () => {
    const live = new Map<string, SessionLabel>([
      ['a', { label: 'Deploy watcher', status: 'ended' }],
    ]);
    const labels = sessionLabels(live, true, server);
    expect(labels).toBe(live);
    expect(labels.get('b')).toBeUndefined(); // not listed live: no stale server status
  });
});
