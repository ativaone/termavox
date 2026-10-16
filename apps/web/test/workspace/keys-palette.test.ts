import type { SessionSummary } from '@termdock/protocol/client';
import { describe, expect, it } from 'vitest';
import { toBayData } from '../../lib/sessions/live.ts';
import { ctrlChar, encodeKey } from '../../lib/workspace/keys.ts';
import { filterPalette, matchScore } from '../../lib/workspace/palette.ts';

describe('phone key bar encoding (plan §11.2)', () => {
  it('maps Ctrl + a printable key to key & 0x1f', () => {
    expect(ctrlChar('c')).toBe('\x03');
    expect(ctrlChar('C')).toBe('\x03');
    expect(ctrlChar('d')).toBe('\x04');
    expect(ctrlChar('[')).toBe('\x1b');
    expect(ctrlChar(' ')).toBe('\x00');
    expect(ctrlChar('é')).toBeNull();
    expect(ctrlChar('ab')).toBeNull();
    expect(encodeKey('|', { ctrl: true })).toBe('\x1c');
    expect(encodeKey('|')).toBe('|');
  });

  it('sends arrows in normal or application cursor mode', () => {
    expect(encodeKey('ArrowUp')).toBe('\x1b[A');
    expect(encodeKey('ArrowDown')).toBe('\x1b[B');
    expect(encodeKey('ArrowRight')).toBe('\x1b[C');
    expect(encodeKey('ArrowLeft')).toBe('\x1b[D');
    expect(encodeKey('ArrowUp', { applicationCursor: true })).toBe('\x1bOA');
    expect(encodeKey('ArrowLeft', { applicationCursor: true })).toBe('\x1bOD');
    // Ctrl+arrow uses xterm's modifier form in both modes.
    expect(encodeKey('ArrowRight', { ctrl: true, applicationCursor: true })).toBe('\x1b[1;5C');
  });

  it('sends Esc and Tab as their bytes', () => {
    expect(encodeKey('Escape')).toBe('\x1b');
    expect(encodeKey('Tab')).toBe('\t');
    expect(encodeKey('Escape', { ctrl: true })).toBe('\x1b');
  });
});

describe('command palette filtering', () => {
  const items = [
    { name: 'deploy', target: 'deploy@api-prod' },
    { name: 'Produção DB', target: 'postgres@db-prod' },
    { name: 'staging', target: 'ubuntu@staging-web' },
    { name: 'reproduce', target: 'root@lab' },
  ];
  const fields = (item: (typeof items)[number]) => [item.name, item.target];

  it('requires every word, ignoring case and accents', () => {
    expect(filterPalette(items, 'prod db', fields).map((i) => i.name)).toEqual(['Produção DB']);
    expect(filterPalette(items, 'PRODUCAO', fields).map((i) => i.name)).toEqual(['Produção DB']);
    expect(filterPalette(items, 'nothing', fields)).toEqual([]);
    expect(filterPalette(items, '  ', fields)).toEqual(items);
  });

  it('ranks field starts, then word starts, then inner matches; earlier fields first', () => {
    expect(filterPalette(items, 'prod', fields).map((i) => i.name)).toEqual([
      'Produção DB', // starts the name
      'deploy', // starts a word of the target ("api-prod")
      'reproduce', // inside the name
    ]);
    expect(matchScore('ubuntu', ['staging', 'ubuntu@staging-web'])).toBeGreaterThan(0);
    expect(matchScore('xyz', ['staging'])).toBeNull();
  });
});

describe('live bay', () => {
  const summary = (
    id: string,
    status: SessionSummary['status'],
    createdAt: number,
    endedAt: number | null = null,
  ): SessionSummary => ({
    id,
    label: id,
    profileId: null,
    hostId: null,
    hostName: 'alpha',
    hostname: '10.0.0.1',
    username: 'deploy',
    state: status === 'ended' ? 'ended' : 'ready',
    status,
    protection: 'tmux-control',
    createdAt,
    lastReadyAt: null,
    endedAt,
    endReason: null,
  });

  it('orders like the server bay: live oldest first, then the latest 20 ended', () => {
    const list = [
      summary('new', 'connected', 30),
      summary('old', 'reconnecting', 10),
      ...Array.from({ length: 22 }, (_, i) => summary(`e${i}`, 'ended', 1, 100 + i)),
    ];
    const bay = toBayData(list);
    expect(bay.endedTotal).toBe(22);
    expect(bay.sessions.slice(0, 3).map((s) => s.id)).toEqual(['old', 'new', 'e21']);
    expect(bay.sessions).toHaveLength(22);
    expect(bay.sessions[0]).toMatchObject({
      user: 'deploy',
      host: 'alpha',
      status: 'reconnecting',
    });
  });
});
