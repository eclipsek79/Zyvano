/**
 * Bridges the shared error model to provider-internal errors.
 *
 * The shared `errors.providerNotConfigured` message is what clients see; the
 * adapter-level error carries the missing environment variable names for the
 * server log so an operator knows exactly what to set.
 */
import { AppError, ERROR_CODES } from '@zyvano/shared';

import { ProviderNotConfiguredError } from './interfaces';

export function providerUnavailableError(
  provider: string,
  capability: string,
  missingEnv: readonly string[],
): AppError {
  return new AppError(
    ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    `The ${capability} provider "${provider}" is not configured on this deployment. ` +
      'An administrator must supply the provider credentials before this operation can run.',
    503,
    { internal: { provider, capability, missingEnv } },
  );
}

export { ProviderNotConfiguredError };
