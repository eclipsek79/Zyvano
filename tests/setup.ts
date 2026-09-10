/**
 * Global test setup.
 *
 * Runs before every test file. Responsibilities, in order:
 *
 *  1. Pin the environment to `test` and refuse to run against a database that is
 *     not obviously a test database — an integration suite that truncates tables
 *     must never be pointed at a real one. This check runs before any test imports
 *     the pool.
 *  2. Start the local AI-provider contract server and point the real adapter base
 *     URLs at it, so provider calls are exercised end to end without external
 *     credentials. Constants are unrelated to application behaviour; no
 *     application module is substituted.
 *  3. Relax throughput rate limits and tighten job retry timings so the suites are
 *     deterministic and fast.
 *
 * Everything here must happen before the first import of `@zyvano/server/...`,
 * because `config/env.ts` validates and memoizes the configuration at import time.
 */
import { config as loadEnv } from 'dotenv';

import { applyStubEnvironment } from './helpers/provider-stub';

loadEnv();

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';

/* ------------------------------- database guard ----------------------------- */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

if (databaseUrl) {
  const databaseName = (() => {
    try {
      return new URL(databaseUrl).pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  })();

  // Guard rail: integration suites drop and recreate schema objects.
  if (!/_test$|_ci$|^test/.test(databaseName)) {
    throw new Error(
      `Refusing to run tests against database "${databaseName}". ` +
        'Point TEST_DATABASE_URL at a database whose name ends in _test.',
    );
  }

  process.env.DATABASE_URL = databaseUrl;
}

/* ---------------------------- provider contract server ---------------------- */

// Awaited at module scope so the base URLs are in place before any test file (and
// therefore before `config/env.ts`) is imported.
await applyStubEnvironment();

/* ---------------------------------- queues --------------------------------- */

// Namespaced so a suite can clear only its own keys and can never disturb a
// developer's local worker. `fileParallelism` is disabled, so one prefix shared by
// the whole test run is safe.
process.env.WORKER_QUEUE_PREFIX = process.env.TEST_QUEUE_PREFIX ?? 'zyvano-test';

// Short backoff with a small attempt budget: the retry-then-dead-letter path is
// asserted explicitly, and the production defaults (5 attempts, 2s exponential
// backoff) would make that assertion take ~30 seconds.
process.env.JOB_MAX_ATTEMPTS = process.env.TEST_JOB_MAX_ATTEMPTS ?? '3';
process.env.JOB_BACKOFF_MS = process.env.TEST_JOB_BACKOFF_MS ?? '100';

// The timeout path is asserted explicitly, so it must complete quickly rather than
// after the production two-minute allowance.
process.env.AI_REQUEST_TIMEOUT_MS = process.env.TEST_AI_REQUEST_TIMEOUT_MS ?? '3000';

/* ------------------------------- rate limiting ------------------------------ */

/**
 * Relax the API rate limits for the functional suites.
 *
 * The default budgets (10 auth attempts per minute) are correct for production
 * but far too tight for a suite that signs in dozens of times from one address;
 * the limiter's in-memory counters are shared per process, so unrelated tests
 * would start failing with 429s depending on execution order.
 *
 * The limiting behaviour itself is not left untested: `tests/api/rate-limit.test.ts`
 * builds its own limiter with a deliberately tiny budget and asserts the 429 path
 * and its headers, so the defence is verified without making every other suite
 * order-dependent.
 */
process.env.RATE_LIMIT_AUTH_MAX = process.env.TEST_RATE_LIMIT_AUTH_MAX ?? '10000';
process.env.RATE_LIMIT_API_MAX = process.env.TEST_RATE_LIMIT_API_MAX ?? '100000';
process.env.RATE_LIMIT_GENERATION_MAX = process.env.TEST_RATE_LIMIT_GENERATION_MAX ?? '10000';
