import type { FileEntry } from '@termdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  countKinds,
  EMPTY_SELECTION,
  hiddenCount,
  isDangling,
  isFolderLike,
  nameCollator,
  planDownloads,
  pruneSelection,
  selectionState,
  setSelected,
  sortEntries,
  toggleSelection,
  visibleEntries,
} from '../../lib/files/listing.ts';
import {
  baseName,
  breadcrumbs,
  joinPath,
  normalizePath,
  parentPath,
  resolvePathInput,
} from '../../lib/files/paths.ts';

function entry(
  name: string,
  type: FileEntry['type'] = 'file',
  extra: Partial<FileEntry> = {},
): FileEntry {
  return { name, type, size: 0, mtime: 0, mode: 0o644, ...extra };
}

describe('file panel paths (plan §5.12)', () => {
  it('joins, normalizes and finds parents; the parent of / is /', () => {
    expect(joinPath('/', 'etc')).toBe('/etc');
    expect(joinPath('/home/td', 'a b')).toBe('/home/td/a b');
    expect(normalizePath('//home/./td/../td//app/')).toBe('/home/td/app');
    expect(normalizePath('/../..')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(parentPath('/etc')).toBe('/');
    expect(parentPath('/home/td/app')).toBe('/home/td');
    expect(baseName('/home/td/app')).toBe('app');
    expect(baseName('/')).toBe('/');
  });

  it('builds breadcrumbs from home inside it and from / elsewhere', () => {
    expect(breadcrumbs('/home/td/app/releases', '/home/td')).toEqual([
      { kind: 'home', name: '~', path: '/home/td' },
      { kind: 'dir', name: 'app', path: '/home/td/app' },
      { kind: 'dir', name: 'releases', path: '/home/td/app/releases' },
    ]);
    expect(breadcrumbs('/home/td', '/home/td')).toEqual([
      { kind: 'home', name: '~', path: '/home/td' },
    ]);
    // A sibling whose name starts like home is not inside it.
    expect(breadcrumbs('/home/td2', '/home/td').map((c) => c.path)).toEqual([
      '/',
      '/home',
      '/home/td2',
    ]);
    expect(breadcrumbs('/', '/home/td')).toEqual([{ kind: 'root', name: '/', path: '/' }]);
    // root's home (/) never replaces the root segment
    expect(breadcrumbs('/var/log', '/')[0]).toEqual({ kind: 'root', name: '/', path: '/' });
    expect(breadcrumbs('/var/log', null).map((c) => c.name)).toEqual(['/', 'var', 'log']);
  });

  it('resolves what is typed in the path bar', () => {
    const at = { current: '/home/td/app', home: '/home/td' };
    expect(resolvePathInput('  /etc/nginx/ ', at)).toBe('/etc/nginx');
    expect(resolvePathInput('~', at)).toBe('/home/td');
    expect(resolvePathInput('~/logs', at)).toBe('/home/td/logs');
    expect(resolvePathInput('releases/../shared', at)).toBe('/home/td/app/shared');
    expect(resolvePathInput('..', at)).toBe('/home/td');
    expect(resolvePathInput('', at)).toBeNull();
    expect(resolvePathInput('a\0b', at)).toBeNull();
    expect(resolvePathInput('~', { current: '/', home: null })).toBeNull();
    expect(resolvePathInput(`/${'x'.repeat(5000)}`, at)).toBeNull();
  });
});

describe('file panel listing (plan §5.12)', () => {
  const entries = [
    entry('file10.txt'),
    entry('file2.txt'),
    entry('File1.txt'),
    entry('zeta', 'dir'),
    entry('.cache', 'dir'),
    entry('current', 'link', { target: 'dir', linkTo: 'releases/2026' }),
    entry('latest.log', 'link', { target: 'file', linkTo: 'logs/latest.log' }),
    entry('broken', 'link', { target: null, linkTo: 'gone' }),
    entry('.env'),
    entry('Alpha', 'dir'),
  ];

  it('puts folders and links to folders first, then files, in natural order', () => {
    const sorted = sortEntries(entries, nameCollator('en')).map((e) => e.name);
    expect(sorted).toEqual([
      '.cache',
      'Alpha',
      'current',
      'zeta',
      '.env',
      'broken',
      'File1.txt',
      'file2.txt',
      'file10.txt',
      'latest.log',
    ]);
    expect(isFolderLike(entry('current', 'link', { target: 'dir' }))).toBe(true);
    expect(isDangling(entry('broken', 'link', { target: null }))).toBe(true);
    expect(isDangling(entry('broken', 'link'))).toBe(true);
    expect(isDangling(entry('current', 'link', { target: 'dir' }))).toBe(false);
  });

  it('hides dot-files unless asked, and counts them', () => {
    expect(visibleEntries(entries, false).map((e) => e.name)).not.toContain('.env');
    expect(visibleEntries(entries, true)).toHaveLength(entries.length);
    expect(hiddenCount(entries)).toBe(2);
  });

  it('keeps a selection by name: toggle, select all, prune, state', () => {
    const names = ['a', 'b', 'c'];
    let selection = toggleSelection(EMPTY_SELECTION, 'a');
    expect(selectionState(selection, names)).toBe('some');
    selection = setSelected(selection, names, true);
    expect(selectionState(selection, names)).toBe('all');
    selection = pruneSelection(selection, ['a', 'c']);
    expect([...selection].sort()).toEqual(['a', 'c']);
    expect(pruneSelection(selection, ['a', 'c', 'd'])).toBe(selection);
    selection = setSelected(selection, names, false);
    expect(selectionState(selection, names)).toBe('none');
    expect(toggleSelection(toggleSelection(EMPTY_SELECTION, 'x'), 'x').size).toBe(0);
  });

  it('counts what a delete removes and splits a download', () => {
    expect(countKinds(entries)).toEqual({ folders: 3, files: 4, links: 3 });
    const plan = planDownloads(entries);
    expect(plan.files.map((e) => e.name)).toEqual([
      'file10.txt',
      'file2.txt',
      'File1.txt',
      'latest.log',
      '.env',
    ]);
    expect(plan.skipped).toBe(5);
  });
});
