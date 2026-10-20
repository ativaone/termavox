import { encodeFrame, FrameFlag, FrameType, type ServerMessage } from '@termavox/protocol';

/**
 * Runtime → attachment wire format (the bytes passed to `AttachmentHandle.send`).
 *
 * The runtime never knows channel numbers: channels are per WebSocket connection and chosen by
 * the client. So the runtime encodes protocol frames with channel 0 and channel-scoped control
 * messages as JSON without their `channel`, and the transport-side handle binds them to its
 * channel (`bindToChannel`). Every `send()` receives a buffer of its own, so binding may patch
 * it in place. This keeps the SessionHost boundary byte-oriented, as §18.1 requires.
 */

type ChannelScoped = Extract<ServerMessage, { channel: number }>;
type WithoutChannel<T> = T extends unknown ? Omit<T, 'channel'> : never;

/** A channel-scoped server message (session.attached, terminal.*) before its channel is set. */
export type ChannelMessage = WithoutChannel<ChannelScoped>;

const PLACEHOLDER_CHANNEL = 0;
const JSON_START = 0x7b; // '{' — binary frame types are 0x01..0x03
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeOutputFrame(seq: number, payload: Uint8Array): Uint8Array {
  return encodeFrame({
    type: FrameType.Output,
    flags: 0,
    channel: PLACEHOLDER_CHANNEL,
    seq: BigInt(seq),
    payload,
  });
}

/** A gzip-compressed SNAPSHOT; `payload` may be shared, the frame is always a fresh buffer. */
export function encodeSnapshotFrame(
  seq: number,
  cols: number,
  rows: number,
  gzipped: Uint8Array,
): Uint8Array {
  return encodeFrame({
    type: FrameType.Snapshot,
    flags: FrameFlag.Gzip,
    channel: PLACEHOLDER_CHANNEL,
    seq: BigInt(seq),
    size: { cols, rows },
    payload: gzipped,
  });
}

export function encodeChannelMessage(message: ChannelMessage): Uint8Array {
  return encoder.encode(JSON.stringify(message));
}

export type BoundFrame = { binary: true; data: Uint8Array } | { binary: false; data: string };

/** Binds a runtime frame to a channel: a binary frame or a JSON text message. */
export function bindToChannel(frame: Uint8Array, channel: number): BoundFrame {
  if (frame[0] === JSON_START) {
    const message = JSON.parse(decoder.decode(frame)) as ChannelMessage;
    return { binary: false, data: JSON.stringify({ ...message, channel }) };
  }
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(2, channel);
  return { binary: true, data: frame };
}
