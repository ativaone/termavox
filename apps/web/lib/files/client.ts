import { TRANSFER_PATH } from '@termavox/protocol/client';
import { FileCode, FileRequestError } from './errors.ts';
import type { FileApi, FileRequestOptions } from './requests.ts';

export interface RemoveOptions extends FileRequestOptions {
  /** Regular files only: folders and links named are skipped (plan D-48's prune). */
  filesOnly?: boolean;
}

/**
 * Typed file operations on one session (plan §5.12), over the tab's connection (`FileApi`), and
 * where the transfer URLs it mints live. Framework-free.
 */
export function sessionFiles(api: FileApi, sessionId: string) {
  return {
    /** The user's home and the terminal's folder (null unless tmux reports it). */
    open: () => api.fileRequest(sessionId, { op: 'open' }),
    list: (path: string) => api.fileRequest(sessionId, { op: 'list', path }),
    /** `mode`: the new folder's permission bits (the server's default without it). */
    mkdir: (path: string, mode?: number) =>
      api.fileRequest(sessionId, { op: 'mkdir', path, ...(mode !== undefined ? { mode } : {}) }),
    rename: (from: string, to: string) => api.fileRequest(sessionId, { op: 'rename', from, to }),
    remove: (paths: string[], options: RemoveOptions = {}) => {
      const { filesOnly, ...requestOptions } = options;
      return api.fileRequest(
        sessionId,
        { op: 'remove', paths, ...(filesOnly ? { filesOnly: true } : {}) },
        requestOptions,
      );
    },
    upload: (dir: string, name: string, size: number, overwrite: boolean) =>
      api.fileRequest(sessionId, { op: 'upload', dir, name, size, overwrite }),
    download: (path: string) => api.fileRequest(sessionId, { op: 'download', path }),
  };
}

export type SessionFiles = ReturnType<typeof sessionFiles>;

/**
 * The absolute URL of a minted transfer path (`/transfer/…`): the transfer routes sit beside the
 * WebSocket (plan §4.3), so they share its origin, `/ws` on this origin in production, the dev
 * override's host otherwise (`ws:` → `http:`, `wss:` → `https:`). A path outside the transfer
 * routes is refused.
 */
export function transferUrl(path: string, wsUrl: string): string {
  if (!path.startsWith(`${TRANSFER_PATH}/`) || path.includes('//') || path.includes('\\')) {
    throw new FileRequestError(FileCode.Internal, 'unexpected transfer URL');
  }
  const ws = new URL(wsUrl);
  const scheme = ws.protocol === 'wss:' ? 'https:' : ws.protocol === 'ws:' ? 'http:' : ws.protocol;
  return new URL(path, `${scheme}//${ws.host}`).href;
}
