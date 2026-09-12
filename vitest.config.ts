import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Test configuration for the whole monorepo.
 *
 * The suites are split by what they actually verify, because they have different
 * prerequisites:
 *
 *   unit        — pure logic (hashing, authorization matrix, validation, URL
 *                 safety). No database, no Redis, no network.
 *   integration — real PostgreSQL and Redis. These exercise repositories,
 *                 services and migrations end to end.
 *   api         — a real Express application driven over HTTP with supertest,
 *                 including authentication, authorization and isolation.
 *
 * End-to-end coverage lives outside this runner: `tests/e2e/*.spec.ts` is executed by
 * Playwright (`npm run test:e2e`) against a real API, worker and browser, because it
 * needs a running process rather than an in-process app. Only `*.test.ts` is collected
 * here, so the two runners never overlap.
 *
 * Aliases mirror the `paths` in tsconfig.base.json (including the wildcard forms)
 * so tests import workspace sources exactly as application code does.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@zyvano\/shared$/,
        replacement: fromRoot('./packages/shared/src/index.ts'),
      },
      {
        find: /^@zyvano\/shared\/(.*)$/,
        replacement: `${fromRoot('./packages/shared/src')}/$1`,
      },
      {
        find: /^@zyvano\/server$/,
        replacement: fromRoot('./packages/server/src/index.ts'),
      },
      {
        find: /^@zyvano\/server\/(.*)$/,
        replacement: `${fromRoot('./packages/server/src')}/$1`,
      },
    ],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration-style suites share a database and truncate between tests, so
    // they must not interleave. Unit tests run in the same pool for simplicity.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: ['tests/setup.ts'],
    reporters: ['default'],
  },
});
