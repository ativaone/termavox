// T1: capability probe against the core test sshd images.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProbeOutput, probeCommand } from '../../src/probe/index.ts';
import { requireSshd, runExec, type SshdImage, sshdTransport } from '../ssh/sshd.ts';

const EXPECTED: Record<string, { tmux: string | null; locale: string }> = {
  'no-tmux': { tmux: null, locale: 'C.UTF-8' },
  'tmux-3.2a': { tmux: 'tmux 3.2a', locale: 'C.utf8' },
  'tmux-edge': { tmux: 'tmux 3.8', locale: 'C.UTF-8' },
};
const IMAGES = Object.keys(EXPECTED) as SshdImage[];

beforeAll(() => requireSshd(IMAGES));

describe.each(IMAGES)('capability probe (%s)', (image) => {
  it('reports shell, tmux, a concrete UTF-8 locale and logind state in one exec', async () => {
    const transport = sshdTransport(image);
    await transport.connect(AbortSignal.timeout(15_000));
    try {
      const { stdout, exit } = await runExec(transport, probeCommand());
      expect(exit.code).toBe(0);
      const probe = parseProbeOutput(stdout);
      const expected = EXPECTED[image]!;
      expect(probe.shell).toBe('/bin/bash');
      expect(probe.tmuxVersionRaw).toBe(expected.tmux);
      expect(probe.tmuxPath).toBe(expected.tmux ? '/usr/bin/tmux' : null);
      expect(probe.utf8Locale).toBe(expected.locale);
      expect(probe.tiTmux256).toBe(true);
      // Containers run no systemd/logind.
      expect(probe).toMatchObject({
        systemdRun: false,
        killUserProcesses: 'unknown',
        linger: 'unknown',
      });
    } finally {
      await transport.close();
    }
  });
});
