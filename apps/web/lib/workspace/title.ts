import { isControlChar, isInvisibleFormatChar } from '@termdock/protocol/client';

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
