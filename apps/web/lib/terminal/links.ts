/**
 * Terminal link policy (plan §10.2): a link opens only when it is http(s), only after the UI's
 * confirmation (the user's preference and the LinkPanel), and always without opener or referrer.
 * Plain-text URLs (web-links addon) and OSC 8 hyperlinks (xterm's `linkHandler`) both go through
 * here; without a handler xterm would open OSC 8 links itself, behind a native `confirm()`.
 */
import type { ILinkHandler } from '@xterm/xterm';

/** Decides whether a clicked link opens (the UI shows its confirmation). */
export type LinkConfirm = (uri: string) => boolean | Promise<boolean>;

export function openLink(uri: string, confirm: LinkConfirm | undefined): void {
  if (!confirm || !/^https?:\/\//i.test(uri)) return;
  void Promise.resolve(confirm(uri)).then(
    (ok) => {
      if (ok) window.open(uri, '_blank', 'noopener,noreferrer');
    },
    () => {},
  );
}

/** xterm's handler for OSC 8 hyperlinks: the same policy as plain-text links. */
export function hyperlinkHandler(confirm: LinkConfirm | undefined): ILinkHandler {
  return {
    activate: (_event, uri) => openLink(uri, confirm),
    allowNonHttpProtocols: false,
  };
}
