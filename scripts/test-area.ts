// T1 runner: `pnpm test:area <area>` runs the integration tests (*.int.test.ts) of one area.
import { spawnSync } from 'node:child_process';

const AREAS: Record<string, string[]> = {
  terminal: ['apps/session-manager/src/emulator', 'packages/terminal-config'],
  ssh: ['apps/session-manager/src/transport', 'apps/session-manager/src/drivers/raw-pty'],
  tmux: ['apps/session-manager/src/drivers/tmux-control', 'apps/session-manager/test/tmux'],
  all: [],
};

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
