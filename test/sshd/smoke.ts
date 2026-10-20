// Smoke check for the test-only sshd containers: `node test/sshd/smoke.ts`.
// Connects to each container with the committed test key, verifies the committed host key
// (never bypassed) and prints `tmux -V` or "absent".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type HostKeyDecision,
  type HostKeyInfo,
  parsePublicKeyLine,
  SshTransport,
} from '../../apps/session-manager/src/transport/ssh/index.ts';

const KEYS = join(import.meta.dirname, 'keys');
const TARGETS = [
  { name: 'no-tmux', port: 2201 },
  { name: 'tmux-3.2a', port: 2202 },
  { name: 'tmux-3.4', port: 2203 },
  { name: 'tmux-edge', port: 2204 },
];

const expected = parsePublicKeyLine(readFileSync(join(KEYS, 'ssh_host_ed25519_key.pub'), 'utf8'));
const privateKey = readFileSync(join(KEYS, 'id_ed25519'), 'utf8');

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function smoke(target: {
  name: string;
  port: number;
}): Promise<{ ok: boolean; line: string }> {
  let presented: HostKeyInfo | null = null;
  let decision: HostKeyDecision = 'unknown';
  const transport = new SshTransport({
    host: '127.0.0.1',
    port: target.port,
    username: 'tv',
    credential: { kind: 'private_key', privateKey },
    verifyHostKey: (key) => {
      presented = key;
      decision =
        key.type === expected.type && key.fingerprint === expected.fingerprint
          ? 'trusted'
          : 'mismatch';
      return decision;
    },
    readyTimeoutMs: 10_000,
  });
  const label = `${target.name.padEnd(10)} 127.0.0.1:${target.port}`;
  try {
    await transport.connect(AbortSignal.timeout(15_000));
    const channel = await transport.exec(
      `exec sh -c 'if command -v tmux >/dev/null 2>&1; then tmux -V; else echo absent; fi'`,
    );
    const [out] = await Promise.all([collect(channel.stdout), collect(channel.stderr)]);
    await channel.exit;
    const key = presented as HostKeyInfo | null;
    return {
      ok: true,
      line: `${label}  host key ${decision} (${key?.type} ${key?.fingerprint})  ${out}`,
    };
  } catch (err) {
    return {
      ok: false,
      line: `${label}  FAILED: ${(err as Error).message} (host key ${decision})`,
    };
  } finally {
    await transport.close();
  }
}

console.log(`expected host key: ${expected.type} ${expected.fingerprint}`);
const results = await Promise.all(TARGETS.map(smoke));
for (const result of results) console.log(result.line);
process.exit(results.every((r) => r.ok) ? 0 : 1);
