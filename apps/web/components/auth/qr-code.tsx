import type { QrCode as QrData } from '../../lib/actions/form-state.ts';

const QUIET_ZONE = 4;

/**
 * A QR code drawn from server-computed path data: dark ink modules on a light field with the
 * standard four-module quiet zone, crisp at any size.
 */
export function QrCode({ qr, label, size = 176 }: { qr: QrData; label: string; size?: number }) {
  const span = qr.size + QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${span} ${span}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-control"
    >
      <title>{label}</title>
      <rect
        x={-QUIET_ZONE}
        y={-QUIET_ZONE}
        width={span}
        height={span}
        fill="var(--color-stock-field)"
      />
      <path d={qr.d} fill="var(--color-stock-ink)" />
    </svg>
  );
}
