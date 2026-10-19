/**
 * Terminal link policy (plan §10.2): a link opens only when it is http(s), only after the UI's
 * confirmation (the user's preference and the LinkPanel), and always without opener or referrer.
 * Plain-text URLs (web-links addon) and OSC 8 hyperlinks (xterm's `linkHandler`) both go through
 * here; without a handler xterm would open OSC 8 links itself, behind a native `confirm()`.
 * The confirmation shows exactly the URL that opens: the parsed `href`, never the raw text.
 */
import type { ILinkHandler } from '@xterm/xterm';

/** Decides whether a clicked link opens (the UI shows its confirmation). */
export type LinkConfirm = (uri: string) => boolean | Promise<boolean>;

/**
 * The URL an http(s) link opens, or null for anything else. The parser's serialization
 * percent-encodes bidi and invisible characters (a U+202E in the user info can no longer make
 * the host read as another one) and gives the host in punycode (an IDN lookalike shows as
 * `xn--…`), so what the user confirms is what the browser opens.
 */
function linkHref(uri: string): string | null {
  // The text itself must start like one, too (the parser alone would take `https:host`).
  if (!/^https?:\/\//i.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

export function openLink(uri: string, confirm: LinkConfirm | undefined): void {
  if (!confirm) return;
  const href = linkHref(uri);
  if (href === null) return;
  void Promise.resolve(confirm(href)).then(
    (ok) => {
      if (ok) window.open(href, '_blank', 'noopener,noreferrer');
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
