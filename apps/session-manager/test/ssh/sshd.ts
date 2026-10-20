/**
 * The test-only sshd containers of test/sshd (compose.yaml). T1 tests require them running:
 *   docker compose -f test/sshd/compose.yaml up -d --build
 * Host keys are verified against the committed key, never bypassed.
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ExecChannel, ExecResult } from '../../src/core/types.ts';
import {
  type HostKeyDecision,
  type HostKeyInfo,
  parsePublicKeyLine,
  SshTransport,
  type SshTransportOptions,
} from '../../src/transport/ssh/index.ts';

export const SSHD_PORTS = {
  'no-tmux': 2201,
  'tmux-3.2a': 2202,
  'tmux-3.4': 2203,
  'tmux-edge': 2204,
} as const;
export type SshdImage = keyof typeof SSHD_PORTS;

const KEYS_DIR = fileURLToPath(new URL('../../../../test/sshd/keys/', import.meta.url));
const readKey = (name: string): string => readFileSync(`${KEYS_DIR}${name}`, 'utf8');

export const HOST_KEY: HostKeyInfo = parsePublicKeyLine(readKey('ssh_host_ed25519_key.pub'));
export const USER_KEY = readKey('id_ed25519');
export const USER_KEY_WITH_PASSPHRASE = readKey('id_ed25519_passphrase');
export const USER_KEY_PASSPHRASE = 'termavox-test-passphrase';
export const TEST_PASSWORD = 'termavox-test-password';
export const TEST_USER = 'tv';

/** Host-key policy that trusts exactly the committed test host key. */
export function trustCommittedHostKey(key: HostKeyInfo): HostKeyDecision {
  return key.type === HOST_KEY.type && key.fingerprint === HOST_KEY.fingerprint
    ? 'trusted'
    : 'mismatch';
}

export function sshdTransport(
  image: SshdImage,
  overrides: Partial<SshTransportOptions> = {},
): SshTransport {
  return new SshTransport({
    host: '127.0.0.1',
    port: SSHD_PORTS[image],
    username: TEST_USER,
    credential: { kind: 'private_key', privateKey: USER_KEY },
    verifyHostKey: trustCommittedHostKey,
    readyTimeoutMs: 10_000,
    ...overrides,
  });
}

/** Fails fast with instructions when a container is not reachable. */
export async function requireSshd(images: readonly SshdImage[]): Promise<void> {
  const down: string[] = [];
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          const socket = connect({ host: '127.0.0.1', port: SSHD_PORTS[image] });
          const done = (ok: boolean): void => {
            if (!ok) down.push(`${image} (127.0.0.1:${SSHD_PORTS[image]})`);
            socket.destroy();
            resolve();
          };
          socket.setTimeout(2_000, () => done(false));
          socket.once('connect', () => done(true));
          socket.once('error', () => done(false));
        }),
    ),
  );
  if (down.length > 0) {
    throw new Error(
      `test sshd not reachable: ${down.join(', ')}. ` +
        'Start it with: docker compose -f test/sshd/compose.yaml up -d --build',
    );
  }
}

export async function collectText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs a command to completion and returns its output. */
export async function runExec(
  transport: SshTransport,
  command: string,
): Promise<{ stdout: string; stderr: string; exit: ExecResult }> {
  const channel: ExecChannel = await transport.exec(command);
  const [stdout, stderr, exit] = await Promise.all([
    collectText(channel.stdout),
    collectText(channel.stderr),
    channel.exit,
  ]);
  return { stdout, stderr, exit };
}
