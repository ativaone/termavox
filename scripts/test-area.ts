// T1 runner: `pnpm test:area <area>` runs the integration tests (*.int.test.ts) of one area.
import { spawnSync } from 'node:child_process';

/** Test paths per area. scripts/test-release.ts reads them to run every T1 file exactly once. */
export const AREAS: Record<string, string[]> = {
  terminal: ['apps/session-manager/test/emulator', 'packages/terminal-config'],
  ssh: ['apps/session-manager/test/ssh', 'apps/session-manager/test/raw-pty'],
  tmux: ['apps/session-manager/test/tmux'],
  files: ['apps/session-manager/test/files'],
  all: [],
};

if (import.meta.main) {
  const area = process.argv[2] ?? '';
  const paths = AREAS[area];
  if (!paths) {
    console.error(`usage: pnpm test:area <${Object.keys(AREAS).join('|')}>`);
    process.exit(2);
  }
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 't1', ...paths], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
