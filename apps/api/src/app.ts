/**
 * Express application assembly.
 *
 * Middleware order is deliberate and security-relevant:
 *   1. security headers and CORS allow-list,
 *   2. request correlation context (so every later log line has an id),
 *   3. body parsing with a hard ceiling,
 *   4. cookie parsing, then session resolution,
 *   5. CSRF verification for state-changing methods,
 *   6. routes (with their own rate limiters),
 *   7. 404 and the terminal error handler.
 */
import cookieParser from 'cookie-parser';
import express, { type Application } from 'express';

import type { Container } from '@zyvano/server/container';
import { getConfig } from '@zyvano/server/config/env';
import { logger } from '@zyvano/server/observability/logger';

import { requestContext } from './http/context';
import { errorHandler, notFoundHandler } from './http/errors';
import { createRateLimiters } from './http/rate-limit';
import { applyCors, applySecurityHeaders, verifyCsrf } from './http/security';
import { attachSession } from './middleware/auth';
import { createAssetRouter } from './routes/asset.routes';
import { createAuthRouter } from './routes/auth.routes';
import { createExportRouter } from './routes/export.routes';
import { createGenerationRouter } from './routes/generation.routes';
import { createHealthRouter } from './routes/health.routes';
import { createOrganizationRouter } from './routes/organization.routes';
import { createProjectRouter } from './routes/project.routes';
import { createScriptRouter } from './routes/script.routes';
import {
  createAuditRouter,
  createJobRouter,
  createNotificationRouter,
  createTemplateRouter,
  createUsageRouter,
  createUserRouter,
} from './routes/support.routes';

/** Maximum JSON body the API will accept. Media never travels as JSON. */
const JSON_BODY_LIMIT = '1mb';

export function createApp(container: Container): Application {
  const app = express();
  const config = getConfig();

  // Behind a load balancer the left-most X-Forwarded-For entry is the real
  // client; without this, rate limiting and audit records would see the proxy.
  app.set('trust proxy', config.isProduction ? 1 : 'loopback');
  app.disable('etag');

  applySecurityHeaders(app);
  applyCors(app);
  app.use(requestContext);

  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  app.use(attachSession(container));
  app.use(verifyCsrf);

  const limiters = createRateLimiters();

  // Health endpoints are intentionally outside the versioned surface and are not
  // rate-limited: an orchestrator must always be able to probe the process.
  app.use('/health', createHealthRouter(container));

  const api = express.Router();

  // One baseline budget for the whole versioned surface. Individual routers add
  // their own tighter budgets (authentication, generation, export) rather than
  // re-applying this one, so a request is never counted twice.
  api.use(limiters.api);

  api.use('/auth', createAuthRouter(container, limiters));
  api.use('/users', createUserRouter(container));
  api.use('/organizations', createOrganizationRouter(container));
  api.use('/projects', createProjectRouter(container));
  api.use('/assets', createAssetRouter(container));
  api.use('/generations', createGenerationRouter(container, limiters));
  api.use('/exports', createExportRouter(container, limiters));
  api.use('/templates', createTemplateRouter(container));
  api.use('/usage', createUsageRouter(container));
  api.use('/audit', createAuditRouter(container));
  api.use('/notifications', createNotificationRouter(container));
  api.use('/jobs', createJobRouter(container));

  // Scripts, storyboards and project-scoped generation history live at mixed
  // depths (some under /projects, some top-level), so this router owns its own
  // full paths and is mounted last at the version root. It carries no
  // router-level guard, which keeps unmatched paths falling through to the 404.
  api.use('/', createScriptRouter(container));

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info({ env: config.nodeEnv }, 'http application assembled');

  return app;
}
