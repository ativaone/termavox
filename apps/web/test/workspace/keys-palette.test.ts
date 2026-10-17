import type { SessionSummary } from '@termdock/protocol/client';
import { describe, expect, it } from 'vitest';
import { formatAddress, formatEndpoint, formatTarget } from '../../lib/servers/target.ts';
import { toBayData } from '../../lib/sessions/live.ts';
import { sessionTarget } from '../../lib/sessions/target.ts';
import { altChar, ctrlChar, encodeKey } from '../../lib/workspace/keys.ts';
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

  it('sends Alt as an ESC prefix (D-17), arrows with modifier 3, both modifiers with 7', () => {
    expect(altChar('b')).toBe('\x1bb');
    expect(altChar('.')).toBe('\x1b.');
    expect(altChar('é')).toBe('\x1bé');
    expect(altChar('')).toBeNull();
    expect(altChar('abc')).toBeNull();
    expect(encodeKey('Tab', { alt: true })).toBe('\x1b\t');
    expect(encodeKey('|', { alt: true })).toBe('\x1b|');
    expect(encodeKey('|', { alt: true, ctrl: true })).toBe('\x1b\x1c');
    expect(encodeKey('Escape', { alt: true })).toBe('\x1b');
    expect(encodeKey('ArrowUp', { alt: true })).toBe('\x1b[1;3A');
    expect(encodeKey('ArrowLeft', { alt: true, applicationCursor: true })).toBe('\x1b[1;3D');
    expect(encodeKey('ArrowDown', { alt: true, ctrl: true })).toBe('\x1b[1;7B');
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
    serverId: 'server-1',
    serverName: 'alpha',
    kind: 'ssh',
    hostname: '10.0.0.1',
    port: 2222,
    username: 'deploy',
    state: status === 'ended' ? 'ended' : 'ready',
    status,
    protection: 'tmux-control',
    createdAt,
    lastReadyAt: null,
    endedAt,
    endReason: null,
    statusDetail: null,
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
      kind: 'ssh',
      username: 'deploy',
      hostname: '10.0.0.1',
      port: 2222,
      status: 'reconnecting',
    });
  });

  it('keeps a session in Reconnecting through the attempts of a retry round (D-31)', () => {
    const attempting = { ...summary('a', 'connecting', 1), attempt: 3, retryUntil: null };
    const restoring = { ...summary('b', 'restoring', 2), attempt: null, retryUntil: 99 };
    const plain = { ...summary('c', 'connecting', 3), attempt: null, retryUntil: null };
    expect(toBayData([attempting, restoring, plain]).sessions.map((s) => s.status)).toEqual([
      'reconnecting',
      'reconnecting',
      'connecting',
    ]);
  });

  it('takes the kind from the summary and marks a session whose server was deleted', () => {
    const local = {
      ...summary('here', 'connected', 5),
      kind: 'local' as const,
      hostname: 'localhost',
      port: 0,
      username: '',
    };
    const orphan = { ...summary('gone', 'disconnected', 6), serverId: null };
    const [here, gone] = toBayData([local, { ...orphan, statusDetail: 'NOT_FOUND' }]).sessions;
    expect(here).toMatchObject({ kind: 'local', serverDeleted: false });
    expect(gone).toMatchObject({ kind: 'ssh', serverDeleted: true });
  });
});

describe('session and server targets (plan D-29)', () => {
  it('reads like an ssh command line: the port only when it is not 22', () => {
    expect(formatTarget('deploy', 'db.internal', 22)).toBe('deploy@db.internal');
    expect(formatTarget('deploy', 'db.internal', 2222)).toBe('deploy@db.internal:2222');
    expect(formatAddress('::1', 22)).toBe('::1');
    expect(formatAddress('fd00::5', 2222)).toBe('[fd00::5]:2222');
    // A host-key decision's scope always names the port.
    expect(formatEndpoint('db.internal', 22)).toBe('db.internal:22');
    expect(formatEndpoint('::1', 22)).toBe('[::1]:22');
  });

  it('uses the local wording for a direct-mode session', () => {
    const ssh = { kind: 'ssh' as const, username: 'u', hostname: 'h', port: 22 };
    expect(sessionTarget(ssh, 'This server')).toBe('u@h');
    expect(sessionTarget({ ...ssh, kind: 'local' }, 'This server')).toBe('This server');
  });
});
