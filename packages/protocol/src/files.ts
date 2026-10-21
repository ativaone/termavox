import { z } from 'zod';

/**
 * File panel (plan §5.12, D-39): the requests a browser sends over the WebSocket, their results,
 * and the limits both sides enforce. Paths are absolute POSIX paths on the session's server;
 * bytes never travel over the WebSocket (uploads and downloads go through `/transfer/*`).
 */

export const FILES_LIMITS = {
  /** An absolute path, in UTF-16 code units. */
  path: 4096,
  /** A file or folder name, in UTF-8 bytes (POSIX NAME_MAX). */
  nameBytes: 255,
  /** Entries returned by one listing; a larger folder sets `truncated`. */
  listEntries: 10_000,
  /** Paths in one `remove` request. */
  removePaths: 1_000,
  /** `files.request` messages one WebSocket connection may have in flight. */
  requestsInFlight: 8,
  /** Uploads and downloads one user may run at once, across browsers. */
  transfersPerUser: 6,
} as const;

/** Lifetime of an upload or download URL, from the request that minted it. */
export const TRANSFER_TOKEN_TTL_MS = 60_000;

/** Path prefix of the transfer routes on session-manager (Caddy forwards it, plan §4.3). */
export const TRANSFER_PATH = '/transfer';

const utf8 = new TextEncoder();

export type FileNameProblem = 'empty' | 'dot' | 'slash' | 'nul' | 'too_long';

/** Why `name` cannot name a file or folder, or null when it can. Shared by browser and daemon. */
export function fileNameProblem(name: string): FileNameProblem | null {
  if (name.length === 0) return 'empty';
  if (name === '.' || name === '..') return 'dot';
  if (name.includes('/')) return 'slash';
  if (name.includes('\0')) return 'nul';
  if (utf8.encode(name).byteLength > FILES_LIMITS.nameBytes) return 'too_long';
  return null;
}

export const FilePath = z
  .string()
  .min(1)
  .max(FILES_LIMITS.path)
  .refine((path) => path.startsWith('/') && !path.includes('\0'), 'absolute path expected');
export type FilePath = z.infer<typeof FilePath>;

/** A name as sent by the browser; the daemon checks it with `fileNameProblem`. */
const FileName = z.string().min(1).max(1024);

/**
 * Permission bits a new folder or file is created with (`0o777` at most: no setuid, setgid or
 * sticky bit). Without it, the server's default applies, as for any creation.
 */
const CreateMode = z.number().int().min(0).max(0o777);

export const FileType = z.enum(['file', 'dir', 'link', 'other']);
export type FileType = z.infer<typeof FileType>;

export const FileEntry = z.object({
  name: FileName,
  /** The entry itself (lstat): a symbolic link is `link`, never what it points to. */
  type: FileType,
  /** Links only: what the link resolves to, or null when it dangles or cannot be read. */
  target: z.enum(['file', 'dir', 'other']).nullable().optional(),
  /** Links only: the link's text (readlink), when it could be read. */
  linkTo: z.string().max(FILES_LIMITS.path).optional(),
  /** Bytes: a link to a file reports the file's size. */
  size: z.number().int().nonnegative(),
  /** Modification time, epoch ms. */
  mtime: z.number().int().nonnegative(),
  /** Permission bits (`0o7777`). */
  mode: z.number().int().min(0).max(0o7777),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** What a `files.request` asks for. */
export const FileRequest = z.discriminatedUnion('op', [
  /** Opens the panel: the user's home and the terminal's current folder. */
  z.object({ op: z.literal('open') }),
  z.object({ op: z.literal('list'), path: FilePath }),
  /**
   * `path` is the new folder's full path; `mode`, its permission bits (the server's umask applies,
   * as to any mkdir). An existing name is CONFLICT and keeps its own bits.
   */
  z.object({ op: z.literal('mkdir'), path: FilePath, mode: CreateMode.optional() }),
  /** Never replaces an existing entry (CONFLICT). */
  z.object({ op: z.literal('rename'), from: FilePath, to: FilePath }),
  /**
   * Folders go with everything inside; links are removed as links, never followed. With
   * `filesOnly`, only regular files (lstat) are removed: a folder, a link or anything else named
   * is skipped, never entered, and is no error.
   */
  z.object({
    op: z.literal('remove'),
    paths: z.array(FilePath).min(1).max(FILES_LIMITS.removePaths),
    filesOnly: z.boolean().optional(),
  }),
  /**
   * Mints an upload URL for one file into `dir`. Without `overwrite`, an existing name: CONFLICT.
   * A new file gets exactly `mode` when given (the server's default otherwise); a replaced file
   * always keeps its own bits.
   */
  z.object({
    op: z.literal('upload'),
    dir: FilePath,
    name: FileName,
    size: z.number().int().nonnegative(),
    overwrite: z.boolean(),
    mode: CreateMode.optional(),
  }),
  /** Mints a download URL for one file. */
  z.object({ op: z.literal('download'), path: FilePath }),
]);
export type FileRequest = z.infer<typeof FileRequest>;

export const FileResult = z.discriminatedUnion('op', [
  /** `cwd`: the terminal's folder (tmux-protected sessions), null when it cannot be known. */
  z.object({ op: z.literal('open'), home: FilePath, cwd: FilePath.nullable() }),
  /** `path` is the canonical path (links resolved) of the folder listed. */
  z.object({
    op: z.literal('list'),
    path: FilePath,
    entries: z.array(FileEntry).max(FILES_LIMITS.listEntries),
    truncated: z.boolean(),
  }),
  z.object({ op: z.literal('mkdir'), entry: FileEntry }),
  z.object({ op: z.literal('rename'), entry: FileEntry }),
  /** Entries removed, everything inside removed folders included. */
  z.object({ op: z.literal('remove'), removed: z.number().int().nonnegative() }),
  /** `url`: a path under TRANSFER_PATH; POST the file's bytes to it once, within the TTL. */
  z.object({ op: z.literal('upload'), transferId: z.string().min(1).max(64), url: z.string() }),
  /** `url`: a path under TRANSFER_PATH; GET it once, within the TTL. */
  z.object({
    op: z.literal('download'),
    transferId: z.string().min(1).max(64),
    url: z.string(),
    name: FileName,
    size: z.number().int().nonnegative(),
  }),
]);
export type FileResult = z.infer<typeof FileResult>;

/** The result type of a given request op. */
export type FileResultOf<Op extends FileRequest['op']> = Extract<FileResult, { op: Op }>;

export const TransferState = z.enum(['running', 'done', 'failed', 'cancelled']);
export type TransferState = z.infer<typeof TransferState>;

/** Body of a refused transfer request, and of an upload's success (`entry`). */
export const TransferResponse = z.union([
  z.object({ entry: FileEntry }),
  z.object({ code: z.string(), message: z.string() }),
]);
export type TransferResponse = z.infer<typeof TransferResponse>;
