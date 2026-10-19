import { resolveWsUrl } from '../terminal/config.ts';
import type { TermdockConnection } from '../terminal/connection.ts';
import { transferUrl } from './client.ts';
import { TransferQueue } from './transfer-queue.ts';

/**
 * Hands a download URL to the browser's own download manager: a hidden `<a download>` click.
 * The response's `Content-Disposition: attachment` makes it a download wherever the URL lives.
 */
export function startBrowserDownload(url: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** The tab's transfer queue, wired to the browser: XHR uploads, anchor downloads (plan §5.12). */
export function createBrowserTransferQueue(connection: TermdockConnection): TransferQueue {
  return new TransferQueue({
    api: connection,
    resolveUrl: (path) => transferUrl(path, resolveWsUrl()),
    createXhr: () => new XMLHttpRequest(),
    startDownload: startBrowserDownload,
  });
}
