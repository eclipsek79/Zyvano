/**
 * Express type augmentation.
 *
 * `auth` is populated by the authentication middleware and `requestId` by the
 * request-context middleware. Declaring them here keeps handlers type-safe
 * without casting.
 */
import type { UserDTO } from '@zyvano/shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      auth?: {
        user: UserDTO;
        sessionId: string;
        csrfTokenHash: string;
        /** When the current session expires (server-side truth). */
        expiresAt: Date;
        /** Organization resolved for this request, when one applies. */
        organizationId: string | null;
      };
    }
  }
}

export {};
