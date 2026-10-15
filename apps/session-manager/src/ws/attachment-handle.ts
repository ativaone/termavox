import { WebSocket } from 'ws';
import { bindToChannel } from '../attachments/wire.ts';
import type { AttachmentHandle } from '../core/types.ts';

/** One attachment = one channel of one WebSocket connection. */
export class WsAttachmentHandle implements AttachmentHandle {
  readonly id: string;
  readonly channel: number;
  readonly #ws: WebSocket;
  #closed = false;

  constructor(id: string, channel: number, ws: WebSocket) {
    this.id = id;
    this.channel = channel;
    this.#ws = ws;
  }

  send(frame: Uint8Array): void {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) return;
    const bound = bindToChannel(frame, this.channel);
    this.#ws.send(bound.data, { binary: bound.binary });
  }

  /** Shared by every channel of the connection: it measures the socket. */
  get bufferedAmount(): number {
    return this.#ws.bufferedAmount;
  }

  /** Detached: frames still in flight from the runtime are dropped. */
  close(): void {
    this.#closed = true;
  }
}
