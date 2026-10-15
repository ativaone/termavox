import { defineConfig } from 'vitest/config';

// T0 = always (fast unit tests, no containers). T1 = area integration tests (*.int.test.ts).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 't0',
          include: ['{apps,packages}/*/{src,test}/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 't1',
          include: ['{apps,packages}/*/{src,test}/**/*.int.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
