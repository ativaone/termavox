import { isControlChar, isInvisibleFormatChar } from '@termavox/protocol/client';

/**
 * Terminal titles come sanitized from the daemon (`sanitizeTitle`, its twin); this also drops
 * control characters and invisible formatting (bidi overrides, zero-width characters), folds
 * whitespace and caps the length.
 */
export function cleanTitle(title: string): string | null {
  const text = Array.from(title)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return !isControlChar(code) && !isInvisibleFormatChar(code);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 120) : null;
}

/** Put before the window title while something rang that the user has not seen. */
export const UNSEEN_BELL_MARKER = '🔔 ';

/**
 * The browser window's title in the desktop workspace: what the active tab shows (the session's
 * label, then its terminal title, both as the tab shows them), with the bell marker while a bell
 * is unseen. With no tab open, `fallback` (the page's own title) as it is.
 */
export function windowTitle(
  tab: { label: string; title: string | null } | null,
  unseenBell: boolean,
  fallback: string,
): string {
  if (!tab) return fallback;
  const marker = unseenBell ? UNSEEN_BELL_MARKER : '';
  const title = tab.title ? ` — ${tab.title}` : '';
  return `${marker}${tab.label}${title} · Termavox`;
}
