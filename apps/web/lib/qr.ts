import './server-guard.ts';
import { encode } from 'uqr';

export interface QrPath {
  /** SVG path data, one unit per module, dark modules only. */
  d: string;
  /** Modules per side (without quiet zone). */
  size: number;
}

/**
 * Encodes text as a QR code and returns it as SVG path data, so the page draws it as plain
 * JSX (`<path d>`): no SVG string, no `dangerouslySetInnerHTML`, no data: image. Each row's
 * runs of dark modules become one rectangle.
 */
export function qrPath(text: string): QrPath {
  const { data, size } = encode(text, { ecc: 'M', border: 0 });
  const parts: string[] = [];
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x += 1;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return { d: parts.join(''), size };
}
