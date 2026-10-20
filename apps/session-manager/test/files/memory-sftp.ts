/**
 * An in-memory SftpSession with POSIX semantics where the file panel depends on them: links are
 * resolved in intermediate path segments, followed by stat/opendir/realpath/open and never by
 * lstat/unlink/rmdir; mkdir and rename refuse an existing target with a generic FAILURE (like
 * OpenSSH); an open file handle keeps its file across renames and unlinks, like an inode; a write
 * clears setuid (and setgid on a group-executable file), like Linux for an unprivileged writer.
 * Every request is recorded, and a test can slow requests down, reorder them or count concurrency.
 */
import { posix } from 'node:path';
import {
  type SftpAttrs,
  type SftpDirEntry,
  SftpError,
  type SftpHandle,
  type SftpOpenFlags,
  type SftpSession,
  SftpStatus,
} from '../../src/core/types.ts';

type FileNode = { kind: 'file'; mode: number; mtime: number; data: Buffer };
type Node =
  | { kind: 'dir'; mode: number; mtime: number }
  | FileNode
  | { kind: 'link'; mtime: number; to: string };
type Handle =
  | { kind: 'dir'; path: string; entries: SftpDirEntry[] | null }
  | { kind: 'file'; path: string; node: FileNode; writable: boolean };

const TYPE_BITS = { dir: 0o040000, file: 0o100000, link: 0o120000 } as const;
const MAX_LINK_HOPS = 40;

export const HOME = '/home/td';

export class MemorySftp implements SftpSession {
  readonly nodes = new Map<string, Node>([['/', { kind: 'dir', mode: 0o755, mtime: 1 }]]);
  /** Every request as `op path` (`rename from to`). */
  readonly ops: string[] = [];
  supportsPosixRename = true;
  /** Entries per readdir answer (OpenSSH sends up to 100). */
  batchSize = 3;
  /**
   * readdir reports what links point to (a stat view) instead of the links themselves: not
   * OpenSSH, but nothing in SFTP forbids it, and removal must stay safe there too.
   */
  readdirFollowsLinks = false;
  /** Runs before every request (await it to slow requests down). */
  delay: ((op: string, path: string) => Promise<void> | void) | null = null;
  /** Bytes one read answers at most: a server answering short. */
  readAnswerMax = Number.POSITIVE_INFINITY;
  /** Permission bits of a new file whose open names none (the server's default, umask applied). */
  newFileMode = 0o644;
  /** The server's umask, applied to the permission bits an open names. */
  umask = 0o022;
  inFlight = 0;
  maxInFlight = 0;
  #closed = false;
  readonly #closeCallbacks: Array<() => void> = [];
  /** Open folders (their listing taken at the first readdir, handed out in batches) and files. */
  readonly #handles = new Map<number, Handle>();
  #nextHandle = 1;

  constructor() {
    this.addDir('/home');
    this.addDir(HOME);
  }

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────

  addDir(path: string, mode = 0o755): this {
    this.nodes.set(path, { kind: 'dir', mode, mtime: 1_700_000_000 });
    return this;
  }

  /** A file of `content` bytes, or of that many zero bytes. */
  addFile(path: string, content: number | Uint8Array = 10, mode = 0o644): this {
    const data = typeof content === 'number' ? Buffer.alloc(content) : Buffer.from(content);
    this.nodes.set(path, { kind: 'file', mode, mtime: 1_700_000_000, data });
    return this;
  }

  /** The bytes of a file (null when there is none at `path`). */
  content(path: string): Buffer | null {
    const node = this.nodes.get(path);
    return node?.kind === 'file' ? node.data : null;
  }

  /** The permission bits of an entry. */
  modeOf(path: string): number | null {
    const node = this.nodes.get(path);
    return node && node.kind !== 'link' ? node.mode : null;
  }

  addLink(path: string, to: string): this {
    this.nodes.set(path, { kind: 'link', mtime: 1_700_000_000, to });
    return this;
  }

  has(path: string): boolean {
    return this.nodes.has(path);
  }

  /** Paths under `dir` (itself excluded), sorted. */
  under(dir: string): string[] {
    return [...this.nodes.keys()].filter((p) => p.startsWith(`${dir}/`)).sort();
  }

  // ── SftpSession ─────────────────────────────────────────────────────────────────────────────

  get closed(): boolean {
    return this.#closed;
  }

  realpath(path: string): Promise<string> {
    return this.#op('realpath', path, () => {
      const full = path === '.' ? HOME : path;
      const resolved = this.#resolve(full, true);
      if (!this.nodes.has(resolved)) throw noSuchFile();
      return resolved;
    });
  }

  stat(path: string): Promise<SftpAttrs> {
    return this.#op('stat', path, () => this.#attrs(this.#existing(this.#resolve(path, true))));
  }

  lstat(path: string): Promise<SftpAttrs> {
    return this.#op('lstat', path, () => this.#attrs(this.#existing(this.#resolve(path, false))));
  }

  readlink(path: string): Promise<string> {
    return this.#op('readlink', path, () => {
      const node = this.#existing(this.#resolve(path, false));
      if (node.kind !== 'link') throw failure('not a link');
      return node.to;
    });
  }

  opendir(path: string): Promise<SftpHandle> {
    return this.#op('opendir', path, () => {
      const resolved = this.#resolve(path, true);
      if (this.#existing(resolved).kind !== 'dir') throw failure('Not a directory');
      return this.#newHandle({ kind: 'dir', path: resolved, entries: null });
    });
  }

  readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null> {
    const id = handleId(handle);
    return this.#op('readdir', this.#handles.get(id)?.path ?? '?', () => {
      const open = this.#handles.get(id);
      if (open?.kind !== 'dir') throw failure('bad handle');
      open.entries ??= ['.', '..', ...this.#children(open.path)].map((name) => {
        if (name === '.' || name === '..') {
          return { name, attrs: this.#attrs({ kind: 'dir', mode: 0o755, mtime: 1 }) };
        }
        const path = posix.join(open.path, name);
        const followed = this.readdirFollowsLinks
          ? this.nodes.get(this.#resolve(path, true))
          : null;
        return { name, attrs: this.#attrs(followed ?? this.nodes.get(path)!) };
      });
      // Small batches, so that paging bugs show.
      const batch = open.entries.splice(0, this.batchSize);
      return batch.length > 0 ? batch : null;
    });
  }

  close(handle: SftpHandle): Promise<void> {
    const id = handleId(handle);
    return this.#op('close', this.#handles.get(id)?.path ?? '?', () => {
      if (!this.#handles.delete(id)) throw failure('bad handle');
    });
  }

  /** Folders and files still open (every flow must close what it opened). */
  get openHandles(): number {
    return this.#handles.size;
  }

  open(path: string, flags: SftpOpenFlags, mode?: number): Promise<SftpHandle> {
    return this.#op('open', path, () => {
      if (flags === 'r') {
        const node = this.#existing(this.#resolve(path, true));
        if (node.kind !== 'file') throw failure('Is a directory');
        return this.#newHandle({ kind: 'file', path, node, writable: false });
      }
      const target = this.#resolve(path, false);
      if (this.nodes.has(target)) throw failure('Failure');
      this.#parentDir(target);
      const node: FileNode = {
        kind: 'file',
        mode: mode === undefined ? this.newFileMode : mode & 0o7777 & ~this.umask,
        mtime: 1_700_000_000,
        data: Buffer.alloc(0),
      };
      this.nodes.set(target, node);
      return this.#newHandle({ kind: 'file', path: target, node, writable: true });
    });
  }

  read(handle: SftpHandle, length: number, position: number): Promise<Uint8Array> {
    const open = this.#handles.get(handleId(handle));
    return this.#op('read', open?.path ?? '?', () => {
      if (open?.kind !== 'file' || !this.#handles.has(handleId(handle))) {
        throw failure('bad handle');
      }
      const count = Math.min(length, this.readAnswerMax);
      return Uint8Array.from(open.node.data.subarray(position, position + count));
    });
  }

  write(handle: SftpHandle, data: Uint8Array, position: number): Promise<void> {
    const open = this.#handles.get(handleId(handle));
    const bytes = Buffer.from(data); // the caller may reuse its buffer once this resolves
    return this.#op('write', open?.path ?? '?', () => {
      if (open?.kind !== 'file' || !open.writable || !this.#handles.has(handleId(handle))) {
        throw failure('bad handle');
      }
      const node = open.node;
      const end = position + bytes.length;
      if (end > node.data.length) {
        const grown = Buffer.alloc(end);
        node.data.copy(grown);
        node.data = grown;
      }
      bytes.copy(node.data, position);
      node.mode &= ~(0o4000 | (node.mode & 0o010 ? 0o2000 : 0));
    });
  }

  fstat(handle: SftpHandle): Promise<SftpAttrs> {
    const open = this.#handles.get(handleId(handle));
    return this.#op('fstat', open?.path ?? '?', () => {
      if (open?.kind !== 'file') throw failure('bad handle');
      return this.#attrs(open.node);
    });
  }

  fchmod(handle: SftpHandle, mode: number): Promise<void> {
    const open = this.#handles.get(handleId(handle));
    return this.#op('fchmod', open?.path ?? '?', () => {
      if (open?.kind !== 'file' || !this.#handles.has(handleId(handle))) {
        throw failure('bad handle');
      }
      open.node.mode = mode & 0o7777;
    });
  }

  mkdir(path: string): Promise<void> {
    return this.#op('mkdir', path, () => {
      const target = this.#resolve(path, false);
      if (this.nodes.has(target)) throw failure('Failure');
      this.#parentDir(target);
      this.addDir(target);
    });
  }

  rmdir(path: string): Promise<void> {
    return this.#op('rmdir', path, () => {
      const target = this.#resolve(path, false);
      const node = this.#existing(target);
      if (node.kind !== 'dir') throw failure('Not a directory');
      if (this.#children(target).length > 0) throw failure('Directory not empty');
      this.nodes.delete(target);
    });
  }

  unlink(path: string): Promise<void> {
    return this.#op('unlink', path, () => {
      const target = this.#resolve(path, false);
      if (this.#existing(target).kind === 'dir') throw failure('Is a directory');
      this.nodes.delete(target);
    });
  }

  rename(from: string, to: string): Promise<void> {
    return this.#op('rename', `${from} ${to}`, () => this.#move(from, to, false));
  }

  posixRename(from: string, to: string): Promise<void> {
    return this.#op('posixRename', `${from} ${to}`, () => this.#move(from, to, true));
  }

  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const cb of this.#closeCallbacks.splice(0)) cb();
  }

  onClose(cb: () => void): void {
    if (this.#closed) queueMicrotask(cb);
    else this.#closeCallbacks.push(cb);
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────

  #newHandle(handle: Handle): SftpHandle {
    const id = this.#nextHandle++;
    this.#handles.set(id, handle);
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, id);
    return bytes;
  }

  async #op<T>(op: string, path: string, run: () => T): Promise<T> {
    if (this.#closed) throw new SftpError(SftpStatus.ConnectionLost, 'closed');
    this.ops.push(`${op} ${path}`);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.delay?.(op, path);
      if (this.#closed) throw new SftpError(SftpStatus.ConnectionLost, 'closed');
      return run();
    } finally {
      this.inFlight--;
    }
  }

  #children(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return [...this.nodes.keys()]
      .filter((p) => p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map((p) => p.slice(prefix.length));
  }

  /** The path with links resolved in every segment (and in the last one when `followLast`). */
  #resolve(path: string, followLast: boolean): string {
    let hops = 0;
    const segments = posix.normalize(path).split('/').filter(Boolean);
    let current = '/';
    for (let i = 0; i < segments.length; i++) {
      let next = posix.join(current, segments[i]!);
      const last = i === segments.length - 1;
      let node = this.nodes.get(next);
      while (node?.kind === 'link' && (!last || followLast)) {
        if (++hops > MAX_LINK_HOPS) throw failure('Too many levels of symbolic links');
        next = posix.resolve(current, node.to);
        node = this.nodes.get(next);
      }
      if (!last && node?.kind !== 'dir') throw noSuchFile();
      current = next;
    }
    return current;
  }

  #existing(path: string): Node {
    const node = this.nodes.get(path);
    if (!node) throw noSuchFile();
    return node;
  }

  #parentDir(path: string): void {
    if (this.nodes.get(posix.dirname(path))?.kind !== 'dir') throw noSuchFile();
  }

  #attrs(node: Node): SftpAttrs {
    if (node.kind === 'link') {
      return { mode: TYPE_BITS.link | 0o777, size: node.to.length, mtime: node.mtime };
    }
    return {
      mode: TYPE_BITS[node.kind] | node.mode,
      size: node.kind === 'file' ? node.data.length : 4096,
      mtime: node.mtime,
    };
  }

  #move(from: string, to: string, replace: boolean): void {
    const source = this.#resolve(from, false);
    const target = this.#resolve(to, false);
    this.#existing(source);
    this.#parentDir(target);
    if (this.nodes.has(target) && !replace) throw failure('Failure');
    for (const path of [source, ...this.under(source)]) {
      const node = this.nodes.get(path)!;
      this.nodes.delete(path);
      this.nodes.set(target + path.slice(source.length), node);
    }
  }
}

function handleId(handle: SftpHandle): number {
  return new DataView(handle.buffer, handle.byteOffset, handle.byteLength).getUint32(0);
}

function noSuchFile(): SftpError {
  return new SftpError(SftpStatus.NoSuchFile, 'No such file');
}

function failure(message: string): SftpError {
  return new SftpError(SftpStatus.Failure, message);
}
