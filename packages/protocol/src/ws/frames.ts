/**
 * WS protocol v1 binary frames (implementation plan §7.2).
 *
 * offset size field
 * 0      1    type    0x01 OUTPUT (S→C) · 0x02 INPUT (C→S) · 0x03 SNAPSHOT (S→C)
 * 1      1    flags   bit0 = payload gzip-compressed (SNAPSHOT only)
 * 2      4    channel u32 BE
 * 6      8    seq     u64 BE (OUTPUT: last chunk seq · SNAPSHOT: snapshotSeq · INPUT: 0)
 * 14     2    cols    u16 BE — SNAPSHOT only
 * 16     2    rows    u16 BE — SNAPSHOT only
 * 14|18  …    payload
 */
export const FrameType = { Output: 0x01, Input: 0x02, Snapshot: 0x03 } as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const FrameFlag = { Gzip: 0x01 } as const;

export const FRAME_HEADER_SIZE = 14;
export const SNAPSHOT_HEADER_SIZE = 18;
export const MAX_CHANNEL = 0xffff_ffff;

export interface BinaryFrame {
  type: FrameType;
  flags: number;
  channel: number;
  seq: bigint;
  /** Terminal size the snapshot was taken at. Required for SNAPSHOT, absent otherwise. */
  size?: { cols: number; rows: number };
  payload: Uint8Array;
}

const VALID_TYPES = new Set<number>(Object.values(FrameType));

export function encodeFrame(frame: BinaryFrame): Uint8Array {
  if (!Number.isInteger(frame.channel) || frame.channel < 0 || frame.channel > MAX_CHANNEL) {
    throw new RangeError(`invalid channel ${frame.channel}`);
  }
  if (frame.seq < 0n || frame.seq > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`invalid seq ${frame.seq}`);
  }
  const isSnapshot = frame.type === FrameType.Snapshot;
  if (isSnapshot !== (frame.size !== undefined)) {
    throw new RangeError('size is required for SNAPSHOT frames and only allowed there');
  }
  const headerSize = isSnapshot ? SNAPSHOT_HEADER_SIZE : FRAME_HEADER_SIZE;
  const out = new Uint8Array(headerSize + frame.payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, frame.type);
  view.setUint8(1, frame.flags & 0xff);
  view.setUint32(2, frame.channel);
  view.setBigUint64(6, frame.seq);
  if (frame.size) {
    view.setUint16(14, frame.size.cols);
    view.setUint16(16, frame.size.rows);
  }
  out.set(frame.payload, headerSize);
  return out;
}

/** Decodes a frame. The payload is a view into `data` (no copy). Throws on malformed input. */
export function decodeFrame(data: Uint8Array): BinaryFrame {
  if (data.byteLength < FRAME_HEADER_SIZE) throw new RangeError('frame too short');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  if (!VALID_TYPES.has(type)) throw new RangeError(`unknown frame type ${type}`);
  const header = {
    type: type as FrameType,
    flags: view.getUint8(1),
    channel: view.getUint32(2),
    seq: view.getBigUint64(6),
  };
  if (type !== FrameType.Snapshot) return { ...header, payload: data.subarray(FRAME_HEADER_SIZE) };
  if (data.byteLength < SNAPSHOT_HEADER_SIZE) throw new RangeError('snapshot frame too short');
  return {
    ...header,
    size: { cols: view.getUint16(14), rows: view.getUint16(16) },
    payload: data.subarray(SNAPSHOT_HEADER_SIZE),
  };
}
