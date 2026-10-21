import { FILES_LIMITS } from '@termavox/protocol';
import { ErrorCode, type TermavoxError } from '@termavox/shared';
import { describe, expect, it } from 'vitest';
import { type SftpDirEntry, SftpError, type SftpHandle, SftpStatus } from '../../src/core/types.ts';
import { namedPath } from '../../src/files/paths.ts';
import {
  entryAt,
  FS_CONCURRENCY,
  home,
  LINK_TEXT_MAX,
  LIST_BYTES_MAX,
  list,
  makeFolder,
  REMOVE_DEPTH_MAX,
  REMOVE_ENTRIES_MAX,
  REMOVE_NAME_BYTES_MAX,
  remove,
  rename,
} from '../../src/files/remote-fs.ts';
import { HOME, MemorySftp } from './memory-sftp.ts';

const MTIME_MS = 1_700_000_000_000;
const FILE_ATTRS = { mode: 0o100644, size: 10, mtime: 1_700_000_000 };
const DIR_ATTRS = { mode: 0o040755, size: 4096, mtime: 1_700_000_000 };
const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');
const handleKey = (handle: SftpHandle): string => Buffer.from(handle).toString('hex');
const errorOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => new Error('expected a failure'),
    (err: unknown) => err,
  );
const codeOf = async (promise: Promise<unknown>): Promise<string | number> => {
  const err = await errorOf(promise);
  return err instanceof SftpError ? err.status : (err as TermavoxError).code;
};

/** /data with every entry type, and /home/tv/data pointing at it. */
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

/**
 * A server whose folder `/endless` never ends: every readdir answers `batchSize` more files, named
 * by `name`. It does end the listing after `safetyEntries`, so that a removal without a bound fails
 * its test instead of filling the memory.
 */
class EndlessFolder extends MemorySftp {
  safetyEntries = 2 * REMOVE_ENTRIES_MAX;
  name = (index: number): string => `f${index}`;
  #listed = 0;
  readonly #handles = new Set<string>();

  override async opendir(path: string): Promise<SftpHandle> {
    const handle = await super.opendir(path);
    if (path === '/endless') this.#handles.add(handleKey(handle));
    return handle;
  }

  override async readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null> {
    if (!this.#handles.has(handleKey(handle))) return super.readdir(handle);
    this.ops.push('readdir /endless');
    if (this.#listed >= this.safetyEntries) return null;
    return Array.from({ length: this.batchSize }, () => ({
      name: this.name(this.#listed++),
      attrs: FILE_ATTRS,
    }));
  }
}

/**
 * A server where every folder under `/nest` holds a file `f` and another folder `n`, however deep
 * a removal goes: each level appears when it is opened. Past `safetyDepth` levels it stops, so that
 * a removal without a depth cap fails its test instead of running on.
 */
class SelfNesting extends MemorySftp {
  safetyDepth = 3 * REMOVE_DEPTH_MAX;

  override opendir(path: string): Promise<SftpHandle> {
    const level = path.split('/').length - 1;
    if (path.startsWith('/nest') && level < this.safetyDepth && !this.has(`${path}/n`)) {
      this.addFile(`${path}/f`).addDir(`${path}/n`);
    }
    return super.opendir(path);
  }
}

/** A server that adds `extra` names to the first answer of one folder's listing. */
class ExtraNames extends MemorySftp {
  folder = '/';
  extra: SftpDirEntry[] = [];
  readonly #handles = new Set<string>();

  override async opendir(path: string): Promise<SftpHandle> {
    const handle = await super.opendir(path);
    if (path === this.folder) this.#handles.add(handleKey(handle));
    return handle;
  }

  override async readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null> {
    const batch = await super.readdir(handle);
    if (batch && this.#handles.delete(handleKey(handle))) return [...batch, ...this.extra];
    return batch;
  }
}

/** What SshSftpSession hands on: ssh2 drops every `.` and `..` from each answer it receives. */
class DotsDropped extends MemorySftp {
  override async readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null> {
    const batch = await super.readdir(handle);
    if (batch === null) return null;
    return batch.filter((entry) => entry.name !== '.' && entry.name !== '..');
  }
}

/**
 * A server that answers each readdir of a folder in `folders` with only `.` and `..`: through ssh2,
 * each answer arrives without a name. A listing ends after `answers` of them, by default far past
 * every cap, so that a reading that does not count such answers fails its test instead of running
 * on.
 */
class HollowFolder extends MemorySftp {
  folders = new Set(['/hollow']);
  answers = 2 * REMOVE_ENTRIES_MAX;
  readonly #listings = new Map<string, { path: string; left: number }>();

  override async opendir(path: string): Promise<SftpHandle> {
    const handle = await super.opendir(path);
    if (this.folders.has(path)) this.#listings.set(handleKey(handle), { path, left: this.answers });
    return handle;
  }

  override async readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null> {
    const listing = this.#listings.get(handleKey(handle));
    if (!listing) return super.readdir(handle);
    this.ops.push(`readdir ${listing.path}`);
    return listing.left-- > 0 ? [] : null;
  }
}

/**
 * A server whose readdir position is an index into the folder as it is now, not as it was when it
 * was opened. Some file systems move entries when others are deleted: a folder read on after its
 * own deletions then skips entries.
 */
class LiveCursor extends MemorySftp {
  readonly #cursors = new Map<string, { path: string; next: number }>();

  override async opendir(path: string): Promise<SftpHandle> {
    const handle = await super.opendir(path);
    this.#cursors.set(handleKey(handle), { path, next: 0 });
    return handle;
  }

  override async readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null> {
    const cursor = this.#cursors.get(handleKey(handle))!;
    this.ops.push(`readdir ${cursor.path}`);
    const names = this.under(cursor.path)
      .map((path) => path.slice(cursor.path.length + 1))
      .filter((name) => !name.includes('/'));
    const page = names.slice(cursor.next, cursor.next + this.batchSize);
    cursor.next += page.length;
    if (page.length === 0) return null;
    return page.map((name) => {
      const dir = this.nodes.get(`${cursor.path}/${name}`)?.kind === 'dir';
      return { name, attrs: dir ? DIR_ATTRS : FILE_ATTRS };
    });
  }
}

/**
 * A server holding names that are not UTF-8 on disk (U+00E9 here stands for a Latin-1 byte). ssh2
 * decodes every name as UTF-8, so such a name is listed with U+FFFD in its place: an lstat or
 * unlink of what was listed finds nothing, and the entry stays in its folder.
 */
class NotUtf8Names extends MemorySftp {
  override async readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null> {
    const batch = await super.readdir(handle);
    if (batch === null) return null;
    return batch.map((entry) => ({ ...entry, name: entry.name.replaceAll('\u00e9', '\ufffd') }));
  }
}

/**
 * A server where another user, once `/work/tree/sub` is removed, renames `/work/tree` away and puts
 * a link to `/outside` in its place (anyone who may write to `/work` can, without a sticky bit).
 */
class ReplacedByLink extends MemorySftp {
  override async rmdir(path: string): Promise<void> {
    await super.rmdir(path);
    if (path !== '/work/tree/sub') return;
    for (const old of ['/work/tree', ...this.under('/work/tree')]) {
      const node = this.nodes.get(old)!;
      this.nodes.delete(old);
      this.nodes.set(old.replace('/work/tree', '/work/tree.old'), node);
    }
    this.addLink('/work/tree', '/outside');
  }
}

/** Watches how many handles `sftp` has open as each of its requests starts (`most`, at most). */
function watchOpenHandles(sftp: MemorySftp): { most: number } {
  const watch = { most: 0 };
  sftp.delay = () => {
    watch.most = Math.max(watch.most, sftp.openHandles);
  };
  return watch;
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

  it('reads on past an answer left without a name once ssh2 dropped `.` and `..`', async () => {
    for (const batchSize of [1, 2]) {
      const sftp = new DotsDropped().addDir('/d');
      sftp.batchSize = batchSize; // `.` and `..` come in answers of their own
      for (let i = 0; i < 5; i++) sftp.addFile(`/d/f${i}`);
      const listing = await list(sftp, '/d');
      expect(listing.truncated).toBe(false);
      expect(listing.entries.map((e) => e.name)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
      expect(sftp.openHandles).toBe(0);
    }
  });

  it('counts an answer without a name as one entry, so that no server keeps it reading', async () => {
    const sftp = new HollowFolder().addDir('/hollow');
    const listing = await list(sftp, '/hollow');
    expect(listing).toMatchObject({ entries: [], truncated: true });
    expect(sftp.ops.filter((op) => op === 'readdir /hollow')).toHaveLength(
      FILES_LIMITS.listEntries + 1,
    );
    expect(sftp.openHandles).toBe(0);
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

  it(`stops past ${LIST_BYTES_MAX / 1024 / 1024} MiB of names, counted in UTF-8, and says so`, async () => {
    const sftp = new MemorySftp().addDir('/wide');
    sftp.batchSize = 100;
    // 1 000 characters and 2 992 bytes each: 1 000 of them are about 3 MB.
    const names = Array.from(
      { length: 1000 },
      (_, i) => `${String(i).padStart(4, '0')}${'界'.repeat(996)}`,
    );
    for (const name of names) sftp.addFile(`/wide/${name}`);
    const listing = await list(sftp, '/wide');
    expect(listing.truncated).toBe(true);
    const fit = Math.floor(LIST_BYTES_MAX / utf8(names[0]!));
    expect(listing.entries.map((e) => e.name)).toEqual(names.slice(0, fit));
    // It stopped reading there, at the 8th of 11 answers.
    expect(sftp.ops.filter((op) => op.startsWith('readdir'))).toHaveLength(8);
    expect(sftp.openHandles).toBe(0);
  });

  it('drops a name it cannot carry as it comes, and counts it against the budget', async () => {
    const sftp = new MemorySftp().addDir('/odd').addFile('/odd/ok');
    // Far longer than a name the protocol carries, as a server is free to send.
    for (let i = 0; i < 100; i++) sftp.addFile(`/odd/${i}${'x'.repeat(100 * 1024)}`);
    const listing = await list(sftp, '/odd');
    expect(listing.entries.map((e) => e.name)).toEqual(['ok']);
    expect(listing.truncated).toBe(true);
    // 21 of these names are over the budget: the 8th answer (3 names each) holds the 21st.
    expect(sftp.ops.filter((op) => op.startsWith('readdir'))).toHaveLength(8);
    expect(sftp.openHandles).toBe(0);
  });

  it(`reports a link's text up to ${LINK_TEXT_MAX} characters`, async () => {
    const fits = `/${'t'.repeat(LINK_TEXT_MAX - 1)}`;
    const tooLong = `/${'t'.repeat(LINK_TEXT_MAX)}`;
    const sftp = new MemorySftp().addDir('/l').addLink('/l/fits', fits).addLink('/l/long', tooLong);
    const byName = Object.fromEntries((await list(sftp, '/l')).entries.map((e) => [e.name, e]));
    expect(byName.fits).toMatchObject({ type: 'link', target: null, linkTo: fits });
    expect(byName.long).toMatchObject({ type: 'link', target: null });
    expect(byName.long).not.toHaveProperty('linkTo');
  });

  it('counts link texts against the same budget, cutting the listing where one no longer fits', async () => {
    const sftp = new MemorySftp().addDir('/links');
    sftp.batchSize = 100;
    const text = `/${'t'.repeat(999)}`;
    const names = Array.from({ length: 3000 }, (_, i) => `l${String(i).padStart(4, '0')}`);
    for (const name of names) sftp.addLink(`/links/${name}`, text);
    const listing = await list(sftp, '/links');
    expect(listing.truncated).toBe(true);
    const bytes = listing.entries.reduce((sum, e) => sum + utf8(e.name) + utf8(e.linkTo ?? ''), 0);
    expect(bytes).toBeLessThanOrEqual(LIST_BYTES_MAX);
    // The first part of the folder, each link in it with its text; the links past it were not read.
    expect(listing.entries.length).toBeGreaterThan(2000);
    expect(listing.entries.map((e) => e.name)).toEqual(names.slice(0, listing.entries.length));
    expect(listing.entries.every((e) => e.linkTo === text)).toBe(true);
    expect(sftp.ops.filter((op) => op.startsWith('readlink ')).length).toBeLessThanOrEqual(
      listing.entries.length + FS_CONCURRENCY,
    );
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

  it('creates a folder with the bits asked for (umask applied); an existing one keeps its own', async () => {
    const sftp = fixture();
    expect(await makeFolder(sftp, namedPath('/data/private'), 0o700)).toMatchObject({
      name: 'private',
      type: 'dir',
      mode: 0o700,
    });
    expect(sftp.modeOf('/data/private')).toBe(0o700);
    // Without a mode, the server's default; the umask narrows a requested one, like mkdir(2).
    await makeFolder(sftp, namedPath('/data/plain'));
    expect(sftp.modeOf('/data/plain')).toBe(0o755);
    sftp.umask = 0o077;
    await makeFolder(sftp, namedPath('/data/narrowed'), 0o750);
    expect(sftp.modeOf('/data/narrowed')).toBe(0o700);
    // No chmod: an existing folder is CONFLICT and keeps its bits.
    sftp.addDir('/data/shared', 0o777);
    expect(await codeOf(makeFolder(sftp, namedPath('/data/shared'), 0o700))).toBe(
      ErrorCode.Conflict,
    );
    expect(sftp.modeOf('/data/shared')).toBe(0o777);
    expect(sftp.ops.filter((op) => op.startsWith('mkdir '))).toEqual([
      'mkdir /data/private',
      'mkdir /data/plain',
      'mkdir /data/narrowed',
    ]);
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
  function tree(sftp = new MemorySftp()): MemorySftp {
    return sftp
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
    const handles = watchOpenHandles(sftp);
    const progress: number[] = [];
    const removed = await remove(sftp, [namedPath('/work/tree')], {
      onProgress: (n) => progress.push(n),
    });
    // Six files and links (a, b, c, d, escape, dangling) and three folders (deeper, sub, tree).
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
    // A folder is closed before the removal goes into one of its folders.
    expect(handles.most).toBe(1);
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

  it('removes only regular files with filesOnly: folders and links are skipped, never entered', async () => {
    const sftp = tree()
      .addLink('/work/to-outside', '/outside')
      .addLink('/work/to-file', '/outside/keep.txt')
      .addFile('/work/plain');
    const kept = sftp.under('/work').filter((path) => path !== '/work/plain');
    const progress: number[] = [];
    const removed = await remove(
      sftp,
      ['/work/tree', '/work/to-outside', '/work/to-file', '/work/missing', '/work/plain'].map(
        namedPath,
      ),
      { filesOnly: true, onProgress: (n) => progress.push(n) },
    );
    expect(removed).toBe(1);
    expect(progress).toEqual([1]);
    expect(sftp.has('/work/plain')).toBe(false);
    // The folder with everything in it, both links and what they point to are all still there.
    expect(sftp.under('/work')).toEqual(kept);
    expect(kept).toContain('/work/tree/sub/deeper/d');
    expect(sftp.has('/outside/keep.txt')).toBe(true);
    // One lstat per target and one unlink: nothing listed, entered or removed as a folder.
    expect(sftp.ops).toEqual([
      'lstat /work/tree',
      'lstat /work/to-outside',
      'lstat /work/to-file',
      'lstat /work/missing',
      'lstat /work/plain',
      'unlink /work/plain',
    ]);
  });

  it('stops a files-only removal between targets when cancelled', async () => {
    const sftp = new MemorySftp().addDir('/p').addFile('/p/a').addFile('/p/b');
    const abort = new AbortController();
    sftp.delay = (op) => {
      if (op === 'unlink') abort.abort();
    };
    const outcome = remove(sftp, [namedPath('/p/a'), namedPath('/p/b')], {
      filesOnly: true,
      signal: abort.signal,
    });
    expect(await codeOf(outcome)).toBe(ErrorCode.Cancelled);
    expect(sftp.has('/p/a')).toBe(false);
    expect(sftp.has('/p/b')).toBe(true);
  });

  it(`keeps at most ${FS_CONCURRENCY} requests in flight`, async () => {
    const sftp = new MemorySftp().addDir('/many');
    sftp.batchSize = 100; // like OpenSSH: one answer holds more than the limit
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
    expect((err as TermavoxError).code).toBe(ErrorCode.Cancelled);
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

  it("fails with the server's own error when a listed name cannot be removed", async () => {
    for (const odd of ['/d/caf\u00e9.txt', '/d/caf\u00e9']) {
      const sftp = new NotUtf8Names().addDir('/d');
      sftp.batchSize = 100;
      for (let i = 0; i < 20; i++) sftp.addFile(`/d/f${i}`);
      if (odd.endsWith('.txt')) sftp.addFile(odd);
      else sftp.addDir(odd);
      let removed = 0;
      const err = await errorOf(
        remove(sftp, [namedPath('/d')], {
          onProgress: (n) => {
            removed = n;
          },
        }),
      );
      // Nothing answers to the listed name (skipped as gone), so the folder's rmdir says why.
      expect(err).toMatchObject({ status: SftpStatus.Failure, message: 'Directory not empty' });
      expect(removed).toBe(20);
      expect(sftp.under('/d')).toEqual([odd]);
      // One listing, then one request per entry: a few dozen requests in all.
      expect(sftp.ops.filter((op) => op === 'opendir /d')).toHaveLength(1);
      expect(sftp.ops.length).toBeLessThan(100);
      expect(sftp.openHandles).toBe(0);
    }
  });

  it('lists a folder once, right after its lstat, and closes it before deleting in it', async () => {
    const sftp = tree();
    sftp.batchSize = 1; // several answers a folder
    expect(await remove(sftp, [namedPath('/work/tree')])).toBe(9);
    const opened = sftp.ops.flatMap((op, index) => (op.startsWith('opendir ') ? [index] : []));
    expect(opened.map((index) => sftp.ops[index])).toEqual([
      'opendir /work/tree',
      'opendir /work/tree/sub',
      'opendir /work/tree/sub/deeper',
    ]);
    for (const index of opened) {
      const path = sftp.ops[index]!.slice('opendir '.length);
      // SFTP has no opendir that refuses a link: the lstat that found a folder is the request
      // just before, so that a swap has no more than that gap.
      expect(sftp.ops[index - 1]).toBe(`lstat ${path}`);
      // Read to its end and closed before anything else is asked.
      const closed = sftp.ops.indexOf(`close ${path}`, index);
      expect(sftp.ops.slice(index + 1, closed).every((op) => op === `readdir ${path}`)).toBe(true);
    }
  });

  it('never lists a folder again, so a link put in its place is not followed', async () => {
    const sftp = tree(new ReplacedByLink());
    const err = await errorOf(remove(sftp, [namedPath('/work/tree')]));
    // Only its rmdir met the link: the server's own error, the link's target as it was.
    expect(err).toMatchObject({ status: SftpStatus.Failure, message: 'Not a directory' });
    expect(sftp.under('/outside')).toEqual([
      '/outside/deep',
      '/outside/deep/keep2.txt',
      '/outside/keep.txt',
    ]);
    expect(sftp.ops.some((op) => op.includes('/outside'))).toBe(false);
    expect(sftp.openHandles).toBe(0);
  });

  it('reads a folder to its end before deleting in it: a moving position loses nothing', async () => {
    const sftp = new LiveCursor().addDir('/d');
    sftp.batchSize = 100;
    for (let i = 0; i < 250; i++) sftp.addFile(`/d/f${String(i).padStart(3, '0')}`);
    expect(await remove(sftp, [namedPath('/d')])).toBe(251);
    expect(sftp.has('/d')).toBe(false);
    // One opening, read to its end (three answers, then the end), and never read again.
    expect(sftp.ops.filter((op) => op === 'opendir /d')).toHaveLength(1);
    expect(sftp.ops.filter((op) => op === 'readdir /d')).toHaveLength(4);
  });

  it('reads on past an answer left without a name once ssh2 dropped `.` and `..`', async () => {
    for (const batchSize of [1, 2]) {
      const sftp = tree(new DotsDropped());
      sftp.batchSize = batchSize; // `.` and `..` come in answers of their own
      expect(await remove(sftp, [namedPath('/work/tree')])).toBe(9);
      expect(sftp.has('/work/tree')).toBe(false);
      expect(sftp.under('/outside')).toEqual([
        '/outside/deep',
        '/outside/deep/keep2.txt',
        '/outside/keep.txt',
      ]);
      expect(sftp.openHandles).toBe(0);
    }
  });

  it(`reads a listing whole before deleting in it, and stops past ${REMOVE_ENTRIES_MAX} entries`, {
    timeout: 30_000,
  }, async () => {
    const sftp = new EndlessFolder().addDir('/endless');
    sftp.batchSize = 100;
    const handles = watchOpenHandles(sftp);
    const err = await errorOf(remove(sftp, [namedPath('/endless')]));
    expect(err).toMatchObject({
      code: ErrorCode.RemoveTooLarge,
      message: expect.stringContaining('too large to delete'),
    });
    // It stopped at the answer that went past the cap, nothing in the folder deleted yet.
    expect(sftp.ops.filter((op) => op === 'readdir /endless')).toHaveLength(
      REMOVE_ENTRIES_MAX / sftp.batchSize + 1,
    );
    expect(sftp.ops.some((op) => op.startsWith('unlink ') || op.startsWith('rmdir'))).toBe(false);
    expect(handles.most).toBe(1);
    expect(sftp.openHandles).toBe(0);
  });

  it('counts what it reads over the whole request, every level together', async () => {
    const sftp = new HollowFolder().addDir('/h').addDir('/h/a').addDir('/h/b');
    sftp.batchSize = 100;
    sftp.folders = new Set(['/h/a', '/h/b']);
    sftp.answers = 60_000; // each folder within the cap, the two together past it
    const err = await errorOf(remove(sftp, [namedPath('/h')]));
    expect(err).toMatchObject({
      code: ErrorCode.RemoveTooLarge,
      message: expect.stringContaining('too large to delete'),
    });
    // /h counted its 2 names and /h/a its 60 000 answers: /h/b had what was left.
    expect(sftp.has('/h/a')).toBe(false);
    expect(sftp.ops.filter((op) => op === 'readdir /h/b')).toHaveLength(
      REMOVE_ENTRIES_MAX - 2 - 60_000 + 1,
    );
    expect(sftp.has('/h/b')).toBe(true);
    expect(sftp.openHandles).toBe(0);
  });

  it('counts what it reads over every target of the request together', async () => {
    const sftp = new HollowFolder().addDir('/h').addDir('/h/a').addDir('/h/b');
    sftp.batchSize = 100;
    sftp.folders = new Set(['/h/a', '/h/b']);
    sftp.answers = 60_000; // each target within the cap, the two together past it
    const err = await errorOf(remove(sftp, [namedPath('/h/a'), namedPath('/h/b')]));
    expect(err).toMatchObject({
      code: ErrorCode.RemoveTooLarge,
      message: expect.stringContaining('too large to delete'),
    });
    // /h/a counted its 60 000 answers: /h/b had what was left, not a budget of its own.
    expect(sftp.has('/h/a')).toBe(false);
    expect(sftp.ops.filter((op) => op === 'readdir /h/b')).toHaveLength(
      REMOVE_ENTRIES_MAX - 60_000 + 1,
    );
    expect(sftp.has('/h/b')).toBe(true);
    expect(sftp.openHandles).toBe(0);
  });

  it(`stops past ${REMOVE_NAME_BYTES_MAX / 1024 / 1024} MiB of names (UTF-8), dropped ones too`, async () => {
    const shapes = [
      // Names the protocol carries, three bytes a character: what a removal keeps until it acts.
      { batchSize: 50, name: (i: number) => `${String(i).padStart(5, '0')}${'界'.repeat(1000)}` },
      // Names far longer than the protocol carries, dropped as they come.
      { batchSize: 3, name: (i: number) => `${String(i).padStart(5, '0')}${'x'.repeat(65_536)}` },
    ];
    for (const { batchSize, name } of shapes) {
      const sftp = new EndlessFolder().addDir('/endless');
      sftp.batchSize = batchSize;
      sftp.name = name;
      const fit = Math.floor(REMOVE_NAME_BYTES_MAX / utf8(name(0)));
      sftp.safetyEntries = 2 * fit;
      const err = await errorOf(remove(sftp, [namedPath('/endless')]));
      expect(err).toMatchObject({
        code: ErrorCode.RemoveTooLarge,
        message: expect.stringContaining('too large to delete'),
      });
      // It stopped at the answer that holds the first name past the budget.
      expect(sftp.ops.filter((op) => op === 'readdir /endless')).toHaveLength(
        Math.floor(fit / batchSize) + 1,
      );
      expect(sftp.ops.some((op) => op.startsWith('unlink ') || op.startsWith('rmdir'))).toBe(false);
      expect(sftp.openHandles).toBe(0);
    }
  });

  it(`stops at a folder nested deeper than ${REMOVE_DEPTH_MAX} levels`, async () => {
    const sftp = new SelfNesting().addDir('/nest');
    const handles = watchOpenHandles(sftp);
    const err = await errorOf(remove(sftp, [namedPath('/nest')]));
    expect(err).toMatchObject({
      code: ErrorCode.RemoveTooLarge,
      message: expect.stringContaining('too deep to delete'),
    });
    // Each level listed once, its file removed before the level below it was opened.
    expect(sftp.ops.filter((op) => op.startsWith('opendir '))).toHaveLength(REMOVE_DEPTH_MAX);
    expect(sftp.ops.filter((op) => op.startsWith('unlink '))).toHaveLength(REMOVE_DEPTH_MAX);
    expect(sftp.ops.indexOf('unlink /nest/f')).toBeLessThan(sftp.ops.indexOf('opendir /nest/n'));
    expect(sftp.ops.some((op) => op.startsWith('rmdir'))).toBe(false);
    // No level is held open while the levels below it are removed: one folder open at a time,
    // however deep, and none left open.
    expect(handles.most).toBe(1);
    expect(sftp.openHandles).toBe(0);
  });

  it('counts an answer without a name as one entry, so that no server keeps it reading', async () => {
    const sftp = new HollowFolder().addDir('/hollow');
    const err = await errorOf(remove(sftp, [namedPath('/hollow')]));
    expect(err).toMatchObject({
      code: ErrorCode.RemoveTooLarge,
      message: expect.stringContaining('too large to delete'),
    });
    expect(sftp.ops.filter((op) => op === 'readdir /hollow')).toHaveLength(REMOVE_ENTRIES_MAX + 1);
    expect(sftp.ops.some((op) => op.startsWith('rmdir'))).toBe(false);
    expect(sftp.openHandles).toBe(0);
  });

  it('skips names a server should not send, never acting outside the folder', async () => {
    const sftp = new ExtraNames();
    sftp.folder = '/work/tree';
    sftp.extra = [
      { name: '../../outside', attrs: DIR_ATTRS },
      { name: 'x/../../../outside/keep.txt', attrs: FILE_ATTRS },
      { name: '', attrs: FILE_ATTRS },
      { name: '.', attrs: DIR_ATTRS },
      { name: 'a\0b', attrs: FILE_ATTRS },
      { name: 'n'.repeat(1025), attrs: FILE_ATTRS },
    ];
    tree(sftp);
    expect(await remove(sftp, [namedPath('/work/tree')])).toBe(9);
    expect(sftp.has('/work/tree')).toBe(false);
    expect(sftp.under('/outside')).toEqual([
      '/outside/deep',
      '/outside/deep/keep2.txt',
      '/outside/keep.txt',
    ]);
    expect(sftp.ops.some((op) => op.includes('/outside'))).toBe(false);
    expect(sftp.ops.some((op) => op.includes('\0') || op.includes('nnnn'))).toBe(false);
    expect(sftp.ops).not.toContain('unlink /work/tree');
  });
});
