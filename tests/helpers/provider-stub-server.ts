/**
 * Standalone runner for the AI-provider contract server.
 *
 * The end-to-end stack needs the same contract server the integration suite uses, but
 * as its own process so the API and worker (which run separately) can reach it.
 * Launching this file with `tsx` reuses the exact implementation from
 * `tests/helpers/provider-stub.ts` rather than duplicating the wire protocols.
 *
 * Usage: PROVIDER_STUB_PORT=4600 npx tsx tests/helpers/provider-stub-server.ts
 *
 * The start is driven by `.then()` rather than top-level await: the repository's base
 * tsconfig emits CommonJS, and top-level await is not representable in that format, so
 * an awaited start would make this file unloadable under `tsx`.
 */
import { startProviderStub } from './provider-stub';

const port = Number(process.env.PROVIDER_STUB_PORT ?? 4600);

startProviderStub(port)
  .then((origin) => {
    // eslint-disable-next-line no-console
    console.log(`[provider-stub] listening on ${origin}`);
    // The listener keeps the event loop alive, so no further work is needed here.
  })
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[provider-stub] failed to start: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
