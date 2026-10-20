import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ErrorCode, type TermdockError } from '@termdock/shared';
import { describe, expect, it } from 'vitest';
import { SftpError, type SftpHandle, SftpStatus } from '../../src/core/types.ts';
import {
  IO_CHUNK_BYTES,
  IO_MAX_IN_FLIGHT,
  SftpFileReader,
  SftpFileWriter,
} from '../../src/files/sftp-io.ts';
import { MemorySftp } from './memory-sftp.ts';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Answers come back in a shuffled order: each request waits 0–4 ms. */
function shuffled(sftp: MemorySftp, op: string): void {
  sftp.delay = (name) => (name === op ? pause(Math.floor(Math.random() * 5)) : undefined);
}

/**
 * A server that answers every read at once except the one at offset 0, which it holds back until
 * the test releases it: a hostile server may answer in any order it likes.
 */
class FirstChunkLast extends MemorySftp {
  readonly release = Promise.withResolvers<void>();

  override read(handle: SftpHandle, length: number, position: number): Promise<Uint8Array> {
    const answer = super.read(handle, length, position);
    return position === 0 ? this.release.promise.then(() => answer) : answer;
  }
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

describe('pipelined SFTP reads', () => {
  it('delivers exactly the file in order, whatever order the answers come in', async () => {
    const content = randomBytes(IO_CHUNK_BYTES * 40 + 1234);
    const sftp = new MemorySftp().addFile('/f', content);
    shuffled(sftp, 'read');
    const handle = await sftp.open('/f', 'r');
    const reader = new SftpFileReader(sftp, handle, content.length);
    expect((await collect(reader)).equals(content)).toBe(true);
    await reader.settled();
    expect(sftp.maxInFlight).toBeLessThanOrEqual(IO_MAX_IN_FLIGHT);
    expect(sftp.maxInFlight).toBeGreaterThan(4);
    expect(sftp.ops.filter((op) => op.startsWith('read'))).toHaveLength(41);
  });

  it('never runs more than the window ahead of what it delivered, whatever order the answers come in', async () => {
    const chunks = 40;
    const content = randomBytes(IO_CHUNK_BYTES * chunks);
    const sftp = new FirstChunkLast().addFile('/f', content);
    const handle = await sftp.open('/f', 'r');
    const reader = new SftpFileReader(sftp, handle, content.length);
    const got = collect(reader);
    const reads = () => sftp.ops.filter((op) => op.startsWith('read')).length;
    await pause(30);
    // Every other answer came back and none of them can be delivered before offset 0: the reader
    // holds them in its window and asks for nothing more, instead of the whole file.
    expect(reads()).toBe(IO_MAX_IN_FLIGHT);
    expect(reader.readableLength).toBe(0);
    sftp.release.resolve();
    expect((await got).equals(content)).toBe(true);
    expect(reads()).toBe(chunks);
  });

  it('sends exactly `size` bytes of a file that grew, and asks again after a short answer', async () => {
    const content = randomBytes(100_000);
    const sftp = new MemorySftp().addFile('/log', content);
    sftp.readAnswerMax = 10_000; // a server answering short
    const handle = await sftp.open('/log', 'r');
    const got = await collect(new SftpFileReader(sftp, handle, 70_000));
    expect(got.equals(content.subarray(0, 70_000))).toBe(true);
  });

  it('fails a file that turns out shorter than its size, never padding it', async () => {
    const sftp = new MemorySftp().addFile('/shrunk', randomBytes(50_000));
    const handle = await sftp.open('/shrunk', 'r');
    const reader = new SftpFileReader(sftp, handle, 80_000);
    const parts: Buffer[] = [];
    const err = await (async () => {
      for await (const part of reader) parts.push(part as Buffer);
    })().catch((e: unknown) => e as TermdockError);
    expect(err).toMatchObject({ code: ErrorCode.FileOpFailed });
    expect(Buffer.concat(parts).length).toBeLessThanOrEqual(50_000);
  });

  it('ends at once for an empty file, without a request', async () => {
    const sftp = new MemorySftp().addFile('/empty', 0);
    const handle = await sftp.open('/empty', 'r');
    expect((await collect(new SftpFileReader(sftp, handle, 0))).length).toBe(0);
    expect(sftp.ops.some((op) => op.startsWith('read'))).toBe(false);
  });

  it('starts no new request while the consumer is behind', async () => {
    const chunks = 200;
    const sftp = new MemorySftp().addFile('/big', IO_CHUNK_BYTES * chunks);
    const handle = await sftp.open('/big', 'r');
    const reader = new SftpFileReader(sftp, handle, IO_CHUNK_BYTES * chunks);
    // A consumer that takes one chunk and then stops, until it is told to drain.
    let held: (() => void) | null = null;
    let draining = false;
    const slow = new Writable({
      highWaterMark: IO_CHUNK_BYTES,
      write(_chunk, _encoding, cb) {
        if (draining) cb();
        else held = () => cb();
      },
    });
    const done = pipeline(reader, slow);
    await pause(30);
    const reads = () => sftp.ops.filter((op) => op.startsWith('read')).length;
    const stalled = reads();
    // The window plus what the streams buffer, not the file.
    expect(stalled).toBeLessThanOrEqual(IO_MAX_IN_FLIGHT * 2);
    await pause(30);
    expect(reads()).toBe(stalled);
    draining = true;
    held!();
    await done;
    expect(reads()).toBe(chunks);
  });
});

describe('pipelined SFTP writes', () => {
  it('writes a stream at the right offsets, at most the window at once, and waits for all', async () => {
    const content = randomBytes(IO_CHUNK_BYTES * 30 + 777);
    const sftp = new MemorySftp().addDir('/up');
    shuffled(sftp, 'write');
    const handle = await sftp.open('/up/f', 'wx');
    const confirmed: number[] = [];
    const writer = new SftpFileWriter(sftp, handle, { onWritten: (n) => confirmed.push(n) });
    // Odd-sized pieces, as an HTTP body arrives.
    const pieces: Buffer[] = [];
    for (let at = 0; at < content.length; at += 10_007)
      pieces.push(content.subarray(at, at + 10_007));
    await pipeline(Readable.from(pieces), writer);
    expect(sftp.content('/up/f')!.equals(content)).toBe(true);
    expect(writer.written).toBe(content.length);
    expect(confirmed.at(-1)).toBe(content.length);
    expect(sftp.maxInFlight).toBeLessThanOrEqual(IO_MAX_IN_FLIGHT);
    expect(sftp.maxInFlight).toBeGreaterThan(4);
    // Whole chunks, then the rest: 31 writes.
    expect(sftp.ops.filter((op) => op.startsWith('write'))).toHaveLength(31);
  });

  it('holds the stream while the window is full (backpressure)', async () => {
    const sftp = new MemorySftp().addDir('/up');
    let gate = Promise.withResolvers<void>();
    sftp.delay = (op) => (op === 'write' ? gate.promise : undefined);
    const handle = await sftp.open('/up/f', 'wx');
    const writer = new SftpFileWriter(sftp, handle);
    const pieces = 40;
    let refused = 0;
    for (let i = 0; i < pieces; i++) {
      if (!writer.write(Buffer.alloc(IO_CHUNK_BYTES, i))) refused++;
    }
    await pause(20);
    // The server holds every answer: the window is full and the rest waits in the stream.
    expect(refused).toBeGreaterThan(0);
    expect(sftp.ops.filter((op) => op.startsWith('write'))).toHaveLength(IO_MAX_IN_FLIGHT);
    expect(writer.writableLength).toBeGreaterThan(0);
    gate.resolve();
    gate = Promise.withResolvers<void>();
    gate.resolve();
    writer.end();
    await new Promise((resolve) => writer.once('finish', resolve));
    const written = sftp.content('/up/f')!;
    expect(written.length).toBe(pieces * IO_CHUNK_BYTES);
    expect(written[IO_CHUNK_BYTES * 39]).toBe(39);
    expect(sftp.maxInFlight).toBeLessThanOrEqual(IO_MAX_IN_FLIGHT);
  });

  it('fails on the first write error, even between body chunks', async () => {
    const sftp = new MemorySftp().addDir('/up');
    let writes = 0;
    sftp.delay = (op) => {
      if (op === 'write' && ++writes === 3) {
        throw new SftpError(SftpStatus.Failure, 'No space left on device');
      }
    };
    const handle = await sftp.open('/up/f', 'wx');
    const writer = new SftpFileWriter(sftp, handle);
    async function* body() {
      for (let i = 0; i < 10; i++) {
        yield Buffer.alloc(IO_CHUNK_BYTES);
        await pause(5);
      }
    }
    const err = await pipeline(Readable.from(body()), writer).catch((e: unknown) => e);
    expect((err as SftpError).status).toBe(SftpStatus.Failure);
    await writer.settled();
    expect(writes).toBeLessThan(10);
  });
});
