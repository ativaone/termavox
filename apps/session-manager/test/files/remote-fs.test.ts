import { ErrorCode, type TermdockError } from '@termdock/shared';
import { describe, expect, it } from 'vitest';
import { SftpError, SftpStatus } from '../../src/core/types.ts';
import { namedPath } from '../../src/files/paths.ts';
import {
  entryAt,
  FS_CONCURRENCY,
  home,
  list,
  makeFolder,
  remove,
  rename,
} from '../../src/files/remote-fs.ts';
import { HOME, MemorySftp } from './memory-sftp.ts';

const MTIME_MS = 1_700_000_000_000;
const errorOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => new Error('expected a failure'),
    (err: unknown) => err,
  );
const codeOf = async (promise: Promise<unknown>): Promise<string | number> => {
  const err = await errorOf(promise);
  return err instanceof SftpError ? err.status : (err as TermdockError).code;
};

/** /data with every entry type, and /home/td/data pointing at it. */
function fixture(): MemorySftp {
  return new MemorySftp()
    .addDir('/data')
    .addFile('/data/notes.txt', 120, 0o640)
    .addFile('/data/.hidden', 3)
    .addDir('/data/sub', 0o700)
    .addLink('/data/to-file', 'notes.txt')
    .addLink('/data/to-dir', '/data/sub')
    .addLink('/data/dangling', '/nowhere')
    .addLink(`${HOME}/data`, '/data');
}

describe('remote file system: listing', () => {
  it("starts at the user's home (realpath .)", async () => {
    expect(await home(new MemorySftp())).toBe(HOME);
  });

  it('lists the lstat view, with each link resolved once (target, size, text)', async () => {
    const sftp = fixture();
    const listing = await list(sftp, `${HOME}/data/`);
    expect(listing.path).toBe('/data'); // canonical: the link was resolved
    expect(listing.truncated).toBe(false);
    const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(
      ['.hidden', 'dangling', 'notes.txt', 'sub', 'to-dir', 'to-file'].sort(),
    );
    expect(byName['notes.txt']).toEqual({
      name: 'notes.txt',
      type: 'file',
      size: 120,
      mtime: MTIME_MS,
      mode: 0o640,
    });
    expect(byName.sub).toMatchObject({ type: 'dir', mode: 0o700 });
    expect(byName['.hidden']).toMatchObject({ type: 'file', size: 3 });
    // A link to a file reports the file's size.
    expect(byName['to-file']).toEqual({
      name: 'to-file',
      type: 'link',
      target: 'file',
      linkTo: 'notes.txt',
      size: 120,
      mtime: MTIME_MS,
      mode: 0o777,
    });
    expect(byName['to-dir']).toMatchObject({ type: 'link', target: 'dir', linkTo: '/data/sub' });
    expect(byName.dangling).toMatchObject({ type: 'link', target: null, linkTo: '/nowhere' });
    // One stat and one readlink per link, nothing for the other entries; the handle is closed.
    expect(sftp.ops.filter((op) => op.startsWith('stat ')).sort()).toEqual([
      'stat /data/dangling',
      'stat /data/to-dir',
      'stat /data/to-file',
    ]);
    expect(sftp.ops.filter((op) => op.startsWith('readlink '))).toHaveLength(3);
    expect(sftp.openHandles).toBe(0);
  });

  it('stops reading past the entry cap and says so', async () => {
    const sftp = new MemorySftp().addDir('/big');
    for (let i = 0; i < 7; i++) sftp.addFile(`/big/f${i}`);
    const capped = await list(sftp, '/big', { limit: 5 });
    expect(capped.entries).toHaveLength(5);
    expect(capped.truncated).toBe(true);
    expect(sftp.openHandles).toBe(0);
    const exact = await list(new MemorySftp().addDir('/d').addFile('/d/a').addFile('/d/b'), '/d', {
      limit: 2,
    });
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.entries).toHaveLength(2);
  });

  it(`resolves links at most ${FS_CONCURRENCY} requests at a time`, async () => {
    const sftp = new MemorySftp().addDir('/links').addFile('/target');
    for (let i = 0; i < 40; i++) sftp.addLink(`/links/l${i}`, '/target');
    sftp.delay = () => new Promise((resolve) => setTimeout(resolve, 1));
    const listing = await list(sftp, '/links');
    expect(listing.entries.every((e) => e.target === 'file')).toBe(true);
    expect(sftp.maxInFlight).toBeLessThanOrEqual(FS_CONCURRENCY);
    expect(sftp.maxInFlight).toBeGreaterThan(1);
  });

  it('fails like the server for a missing folder or a file', async () => {
    const sftp = fixture();
    expect(await codeOf(list(sftp, '/missing'))).toBe(SftpStatus.NoSuchFile);
    expect(await codeOf(list(sftp, '/data/notes.txt'))).toBe(SftpStatus.Failure);
  });

  it('leaves out names the protocol cannot carry', async () => {
    const sftp = new MemorySftp()
      .addDir('/odd')
      .addFile('/odd/ok')
      .addFile(`/odd/${'n'.repeat(1025)}`);
    expect((await list(sftp, '/odd')).entries.map((e) => e.name)).toEqual(['ok']);
  });
});

describe('remote file system: changes', () => {
  it('creates a folder and refuses an existing name, a link included (CONFLICT)', async () => {
    const sftp = fixture();
    expect(await makeFolder(sftp, namedPath('/data/new'))).toMatchObject({
      name: 'new',
      type: 'dir',
    });
    expect(sftp.has('/data/new')).toBe(true);
    for (const existing of ['/data/sub', '/data/notes.txt', '/data/dangling']) {
      expect(await codeOf(makeFolder(sftp, namedPath(existing)))).toBe(ErrorCode.Conflict);
    }
    expect(await codeOf(makeFolder(sftp, namedPath('/missing/new')))).toBe(SftpStatus.NoSuchFile);
  });

  it('answers CONFLICT when the name appeared between the check and mkdir', async () => {
    const sftp = fixture();
    let raced = false;
    sftp.delay = (op) => {
      if (op === 'mkdir' && !raced) {
        raced = true;
        sftp.addDir('/data/late');
      }
    };
    expect(await codeOf(makeFolder(sftp, namedPath('/data/late')))).toBe(ErrorCode.Conflict);
  });

  it('renames and moves, never over an existing entry', async () => {
    const sftp = fixture();
    expect(
      await rename(sftp, namedPath('/data/notes.txt'), namedPath('/data/sub/moved.txt')),
    ).toMatchObject({ name: 'moved.txt', type: 'file', size: 120 });
    expect(sftp.has('/data/notes.txt')).toBe(false);
    expect(sftp.has('/data/sub/moved.txt')).toBe(true);

    const before = [...sftp.nodes.keys()].sort();
    expect(
      await codeOf(rename(sftp, namedPath('/data/.hidden'), namedPath('/data/sub/moved.txt'))),
    ).toBe(ErrorCode.Conflict);
    expect(await codeOf(rename(sftp, namedPath('/data/.hidden'), namedPath('/data/to-dir')))).toBe(
      ErrorCode.Conflict,
    );
    expect([...sftp.nodes.keys()].sort()).toEqual(before);
    expect(sftp.ops.some((op) => op.startsWith('posixRename'))).toBe(false);
    expect(await codeOf(rename(sftp, namedPath('/data/gone'), namedPath('/data/x')))).toBe(
      SftpStatus.NoSuchFile,
    );
  });

  it('describes a link entry with its target', async () => {
    expect(await entryAt(fixture(), '/data/to-dir', 'to-dir')).toMatchObject({
      type: 'link',
      target: 'dir',
      linkTo: '/data/sub',
    });
  });
});

describe('remote file system: removal', () => {
  /** /work/tree holds files, nested folders and a link to /outside, which holds a file. */
  function tree(): MemorySftp {
    return new MemorySftp()
      .addDir('/outside')
      .addFile('/outside/keep.txt')
      .addDir('/outside/deep')
      .addFile('/outside/deep/keep2.txt')
      .addDir('/work')
      .addDir('/work/tree')
      .addFile('/work/tree/a')
      .addFile('/work/tree/b')
      .addDir('/work/tree/sub')
      .addFile('/work/tree/sub/c')
      .addDir('/work/tree/sub/deeper')
      .addFile('/work/tree/sub/deeper/d')
      .addLink('/work/tree/sub/escape', '/outside')
      .addLink('/work/tree/sub/dangling', '/nowhere');
  }

  it('removes a tree depth first and never follows a link to a folder', async () => {
    const sftp = tree();
    const progress: number[] = [];
    const removed = await remove(sftp, [namedPath('/work/tree')], {
      onProgress: (n) => progress.push(n),
    });
    // a, b, c, d, escape, dangling, deeper, sub, tree
    expect(removed).toBe(9);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sftp.has('/work/tree')).toBe(false);
    expect(sftp.has('/work')).toBe(true);
    // The link's target folder and everything in it survive.
    expect(sftp.under('/outside')).toEqual([
      '/outside/deep',
      '/outside/deep/keep2.txt',
      '/outside/keep.txt',
    ]);
    expect(sftp.ops.some((op) => op.includes('/outside'))).toBe(false);
    expect(sftp.ops.some((op) => op.startsWith('stat '))).toBe(false);
    expect(sftp.ops.filter((op) => op.startsWith('opendir ')).sort()).toEqual([
      'opendir /work/tree',
      'opendir /work/tree/sub',
      'opendir /work/tree/sub/deeper',
    ]);
    expect(sftp.openHandles).toBe(0);
  });

  it('never enters a link to a folder even when the listing calls it a folder', async () => {
    const sftp = tree();
    sftp.readdirFollowsLinks = true;
    expect(await remove(sftp, [namedPath('/work/tree')])).toBe(9);
    expect(sftp.under('/outside')).toEqual([
      '/outside/deep',
      '/outside/deep/keep2.txt',
      '/outside/keep.txt',
    ]);
    // The listing said folder: an lstat of the link itself decided, then it was unlinked.
    expect(sftp.ops).toContain('lstat /work/tree/sub/escape');
    expect(sftp.ops).toContain('unlink /work/tree/sub/escape');
    expect(sftp.ops.some((op) => op.startsWith('opendir /work/tree/sub/escape'))).toBe(false);
    expect(sftp.ops.some((op) => op.includes('/outside'))).toBe(false);
  });

  it('removes a link named directly as a link, and skips what is already gone', async () => {
    const sftp = tree().addLink('/work/to-outside', '/outside');
    const removed = await remove(sftp, [
      namedPath('/work/to-outside'),
      namedPath('/work/missing'),
      namedPath('/work/tree/a'),
    ]);
    expect(removed).toBe(2);
    expect(sftp.has('/work/to-outside')).toBe(false);
    expect(sftp.has('/outside/keep.txt')).toBe(true);
  });

  it(`keeps at most ${FS_CONCURRENCY} requests in flight`, async () => {
    const sftp = new MemorySftp().addDir('/many');
    for (let i = 0; i < 50; i++) sftp.addFile(`/many/f${i}`);
    sftp.delay = () => new Promise((resolve) => setTimeout(resolve, 1));
    expect(await remove(sftp, [namedPath('/many')])).toBe(51);
    expect(sftp.maxInFlight).toBeLessThanOrEqual(FS_CONCURRENCY);
    expect(sftp.maxInFlight).toBeGreaterThan(1);
  });

  it('stops between requests when cancelled (CANCELLED), and nothing runs after the answer', async () => {
    const sftp = new MemorySftp().addDir('/many');
    for (let i = 0; i < 50; i++) sftp.addFile(`/many/f${i}`);
    sftp.delay = () => new Promise((resolve) => setTimeout(resolve, 2));
    const abort = new AbortController();
    let seen = 0;
    const err = await errorOf(
      remove(sftp, [namedPath('/many')], {
        signal: abort.signal,
        onProgress: (n) => {
          seen = n;
          if (n === 10) abort.abort();
        },
      }),
    );
    expect((err as TermdockError).code).toBe(ErrorCode.Cancelled);
    const opsAtAnswer = sftp.ops.length;
    const left = sftp.under('/many').length;
    // The requests already running when it was cancelled finish; nothing new starts.
    expect(seen).toBeGreaterThanOrEqual(10);
    expect(seen).toBeLessThan(10 + FS_CONCURRENCY);
    expect(left).toBe(50 - seen);
    expect(sftp.has('/many')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sftp.ops.length).toBe(opsAtAnswer);
    expect(sftp.inFlight).toBe(0);
  });

  it('stops at the first failure without starting more requests', async () => {
    const sftp = new MemorySftp().addDir('/d');
    for (let i = 0; i < 30; i++) sftp.addFile(`/d/f${i}`);
    sftp.delay = (op, path) => {
      if (op === 'unlink' && path === '/d/f3') {
        throw new SftpError(SftpStatus.PermissionDenied, 'Permission denied');
      }
      return new Promise((resolve) => setTimeout(resolve, 1));
    };
    expect(await codeOf(remove(sftp, [namedPath('/d')]))).toBe(SftpStatus.PermissionDenied);
    const opsAtAnswer = sftp.ops.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sftp.ops.length).toBe(opsAtAnswer);
    expect(sftp.ops.some((op) => op.startsWith('rmdir'))).toBe(false);
  });
});
