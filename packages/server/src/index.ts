/**
 * Public surface of the Zyvano server package.
 *
 * Applications import deep paths (`@zyvano/server/container`) so that bundlers
 * only pull in what they use; this barrel exists for convenience and to document
 * which modules are intended to be consumed from outside the package.
 */
export { buildContainer, type Container } from './container';
export { getConfig, type AppConfig } from './config/env';
export { logger, withContext, redact } from './observability/logger';
export {
  getRequestContext,
  runWithRequestContext,
  patchRequestContext,
} from './observability/request-context';
export { closePool, checkDatabaseHealth, query, queryOne, withTransaction } from './db/pool';
export { AuthorizationService, roleHasPermission, roleAtLeast } from './services/authorization-service';
export { AuthService } from './services/auth-service';
export { ProjectService } from './services/project-service';
export { SceneService } from './services/scene-service';
export { ScriptService } from './services/script-service';
export { AssetService } from './services/asset-service';
export { GenerationService } from './services/generation-service';
export { ExportService } from './services/export-service';
export { DeletionService } from './services/deletion-service';
export { OrganizationService } from './services/organization-service';
export { TemplateService, SYSTEM_TEMPLATES } from './services/template-service';
export { UsageService } from './services/usage-service';
export { NotificationService } from './services/notification-service';
export { AuditService } from './services/audit-service';
export { createMediaProcessor, type MediaProcessor } from './infrastructure/media/processor';
export {
  createQueue,
  createQueueConsumer,
  type QueueService,
  type QueueConsumer,
  type JobContext,
  type JobEnvelope,
  type JobHandler,
} from './infrastructure/queue/queue';
