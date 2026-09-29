import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    // Every project blocks non-loopback network access so tests can never
    // reach real GitHub or OpenAI endpoints by accident.
    setupFiles: ['./test/setup/network-guard.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli/**'],
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['./test/setup/integration-global.ts'],
          // Integration suites share one disposable database; run files serially.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          globalSetup: ['./test/setup/integration-global.ts'],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
