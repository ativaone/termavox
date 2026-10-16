import { describe, expect, it } from 'vitest';
import {
  collapseRuns,
  describeStateChange,
  phaseOf,
  type StateChangeWords,
} from '../lib/sessions/activity.ts';
import en from '../messages/en.json' with { type: 'json' };
import ptBR from '../messages/pt-BR.json' with { type: 'json' };

const words: StateChangeWords = {
  status: (status) => en.workspace.status[status],
  phase: (phase) => en.activity.detail.phase[phase],
  transition: (from, to) => `${from} → ${to}`,
  reason: (code) => (code === 'AUTH_REJECTED' ? 'The host rejected the sign-in.' : null),
};

describe('activity log: phases of a state change', () => {
  it('names the step of the internal states that share "Connecting…"', () => {
    expect(phaseOf('verifying_host')).toBe('checkingHostKey');
    expect(phaseOf('authenticating')).toBe('signingIn');
    expect(phaseOf('probing')).toBe('checkingHost');
    expect(phaseOf('starting')).toBe('startingShell');
    expect(phaseOf('syncing')).toBe('syncingScreen');
    for (const state of ['new', 'connecting', 'ready', 'failed', 'nonsense', null]) {
      expect(phaseOf(state)).toBeNull();
    }
    for (const catalog of [en, ptBR]) {
      expect(Object.keys(catalog.activity.detail.phase).sort()).toEqual(
        ['checkingHost', 'checkingHostKey', 'signingIn', 'startingShell', 'syncingScreen'].sort(),
      );
    }
  });

  it('public status first, then the target phase; no "A → A" inside one status', () => {
    expect(describeStateChange({ from: 'verifying_host', to: 'authenticating' }, words)).toBe(
      'Connecting… · Signing in',
    );
    expect(describeStateChange({ from: 'new', to: 'connecting' }, words)).toBe('Connecting…');
    expect(describeStateChange({ from: 'probing', to: 'starting' }, words)).toBe(
      'Connecting… · Starting the shell',
    );
    expect(describeStateChange({ from: 'starting', to: 'ready' }, words)).toBe(
      'Connecting… → Connected',
    );
    expect(describeStateChange({ from: 'reconnecting', to: 'verifying_host' }, words)).toBe(
      'Reconnecting… → Connecting… · Checking the host key',
    );
    expect(
      describeStateChange({ from: 'authenticating', to: 'failed', detail: 'AUTH_REJECTED' }, words),
    ).toBe('Connecting… → Disconnected · The host rejected the sign-in.');
    expect(describeStateChange({ to: 'syncing' }, words)).toBe('Connecting… · Syncing the screen');
    expect(describeStateChange({ from: 'ready', to: 'bogus' }, words)).toBe('');
  });
});

describe('activity log: repeats in a row collapse into one row with a count', () => {
  const row = (id: string, sessionId: string, type: string, summary: string) => ({
    id,
    sessionId,
    type,
    summary,
  });
  const key = (r: ReturnType<typeof row>) => JSON.stringify([r.sessionId, r.type, r.summary]);

  it('merges only consecutive rows of the same session, event and words; keeps the newest', () => {
    const rows = [
      row('9', 'a', 'state_changed', 'Connecting… · Signing in'),
      row('8', 'a', 'state_changed', 'Connecting… · Signing in'),
      row('7', 'a', 'state_changed', 'Connecting… · Signing in'),
      row('6', 'b', 'state_changed', 'Connecting… · Signing in'), // other session
      row('5', 'a', 'state_changed', 'Connecting… · Signing in'), // not adjacent any more
      row('4', 'a', 'state_changed', 'Connecting… · Checking the host'), // other words
      row('3', 'a', 'attached', ''),
      row('2', 'a', 'detached', ''), // other event
      row('1', 'a', 'detached', ''),
    ];
    expect(collapseRuns(rows, key).map((r) => [r.row.id, r.count])).toEqual([
      ['9', 3],
      ['6', 1],
      ['5', 1],
      ['4', 1],
      ['3', 1],
      ['2', 2],
    ]);
    expect(collapseRuns([], key)).toEqual([]);
  });
});
