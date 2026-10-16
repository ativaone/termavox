import { type ExecChannel, type Transport, TransportError } from '../core/types.ts';
import { type ProbeResult, parseProbeOutput, probeCommand } from './probe.ts';

/** The probe's stdout is host-controlled: at most this much is read (UTF-8 bytes). */
export const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Runs the capability probe over a connected transport (plan §5.11), for sessions and host
 * tests alike. stdout is read up to `maxBytes` and stderr is drained without being kept. Beyond
 * the cap, or after `timeoutMs`, the channel is closed and the probe fails with a retryable
 * TransportError (`PROBE_TOO_LARGE`, `PROBE_TIMEOUT`), the same way as a probe timeout.
 */
export async function runProbe(
  transport: Transport,
  timeoutMs: number,
  maxBytes = PROBE_MAX_OUTPUT_BYTES,
): Promise<ProbeResult> {
  const channel = await transport.exec(probeCommand());
  const readStdout = async (): Promise<Buffer> => {
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const part of channel.stdout) {
      size += part.byteLength;
      if (size > maxBytes) {
        throw new TransportError(
          'PROBE_TOO_LARGE',
          `capability probe output exceeds ${maxBytes} bytes`,
          true,
        );
      }
      parts.push(part);
    }
    return Buffer.concat(parts);
  };
  const drain = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
    for await (const _part of stream) {
      // discarded
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TransportError('PROBE_TIMEOUT', 'capability probe timed out', true)),
      timeoutMs,
    );
  });
  try {
    const [stdout] = await Promise.race([
      Promise.all([readStdout(), drain(channel.stderr), channel.exit]),
      timeout,
    ]);
    return parseProbeOutput(stdout.toString('utf8'));
  } catch (err) {
    closeChannel(channel);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function closeChannel(channel: ExecChannel): void {
  try {
    if (channel.close) channel.close();
    else channel.end();
  } catch {
    // Already closed.
  }
}
