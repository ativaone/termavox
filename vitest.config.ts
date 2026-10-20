import { defineConfig } from 'vitest/config';

// T0 = always (fast unit tests, no containers). T1 = area integration tests (*.int.test.ts).
// Workers are capped: dev machines may be small (each worker loads xterm, SQLite, Better Auth).
export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: 't0',
          include: [
            '{apps,packages}/*/{src,test}/**/*.test.ts',
            'site/test/**/*.test.ts',
            'scripts/test/**/*.test.ts',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 't1',
          include: ['{apps,packages}/*/{src,test}/**/*.int.test.ts'],
          // Integration files share the sshd containers and are memory-heavy: one at a time.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
