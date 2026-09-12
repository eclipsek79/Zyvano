/**
 * Playwright configuration for the Zyvano end-to-end suite.
 *
 * The suite runs against the real stack, not a mock: a real API process, a real
 * worker process consuming the real BullMQ queue, a real PostgreSQL database, a
 * real object-storage driver, and the real Vite-served frontend. `scripts/e2e-env.mjs`
 * starts all of it (including a local provider contract server standing in for the
 * third-party AI vendors, which need credentials this environment lacks) and the
 * `webServer` block below merely waits for it and tears it down.
 *
 * `reuseExistingServer` stays false for the managed runner but the command honours
 * `E2E_BASE_URL`, so a developer who already has `npm run dev:api`,
 * `npm run dev:worker` and `npm run dev:web` running can point the suite at that
 * stack instead of having a second one started for them.
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const reuseExisting = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: './tests/e2e',
  // The suite shares one database and one queue, and the workflow spec asserts on
  // sequencing, so specs run one at a time in a single worker.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  // Generous budgets: a full flow includes a real video generation and a real
  // ffmpeg render, which together take tens of seconds on a small runner.
  timeout: 180_000,
  expect: { timeout: 60_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // The app is same-origin and cookie-based; no extra context options needed.
    ignoreHTTPSErrors: false,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: reuseExisting
    ? undefined
    : {
        command: 'node scripts/e2e-env.mjs',
        url: baseURL,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
