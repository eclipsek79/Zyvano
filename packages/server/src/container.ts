/**
 * Dependency injection container.
 *
 * A single, explicitly constructed graph shared by the API and the worker. This
 * keeps infrastructure (db, storage, queue, providers, mailer) behind
 * interfaces so tests can substitute in-memory implementations without touching
 * service code.
 */
import { getConfig, type AppConfig } from './config/env';
import { closePool } from './db/pool';
import { createMailer, type Mailer } from './infrastructure/email/mailer';
import { createObjectStorage, type ObjectStorage } from './infrastructure/storage';
import { createQueue, type QueueService } from './infrastructure/queue/queue';
import { createProviderRegistry, type ProviderRegistry } from './infrastructure/ai/registry';
import { createMediaProcessor, type MediaProcessor } from './infrastructure/media/processor';

import { AuditRepository } from './repositories/audit-repository';
import { AssetRepository } from './repositories/asset-repository';
import { DeletionRequestRepository } from './repositories/deletion-request-repository';
import { ExportRepository } from './repositories/export-repository';
import { GenerationRepository } from './repositories/generation-repository';
import { JobRepository } from './repositories/job-repository';
import { NotificationRepository } from './repositories/notification-repository';
import { OrganizationRepository } from './repositories/organization-repository';
import { ProjectRepository } from './repositories/project-repository';
import { SceneRepository } from './repositories/scene-repository';
import { ScriptRepository } from './repositories/script-repository';
import { SessionRepository } from './repositories/session-repository';
import { TemplateRepository } from './repositories/template-repository';
import { UsageRepository } from './repositories/usage-repository';
import { UserRepository } from './repositories/user-repository';

import { AuditService } from './services/audit-service';
import { AuthService } from './services/auth-service';
import { AuthorizationService } from './services/authorization-service';
import { AssetService } from './services/asset-service';
import { ExportService } from './services/export-service';
import { GenerationService } from './services/generation-service';
import { OrganizationService } from './services/organization-service';
import { ProjectService } from './services/project-service';
import { ScriptService } from './services/script-service';
import { SceneService } from './services/scene-service';
import { TemplateService } from './services/template-service';
import { UsageService } from './services/usage-service';
import { NotificationService } from './services/notification-service';
import { DeletionService } from './services/deletion-service';

export interface Container {
  config: AppConfig;
  storage: ObjectStorage;
  mailer: Mailer;
  queue: QueueService;
  providers: ProviderRegistry;
  media: MediaProcessor;

  /**
   * Releases the connections this graph owns (queue clients, database pool).
   * Called during graceful shutdown by both the API and the worker.
   */
  close(): Promise<void>;

  repositories: {
    users: UserRepository;
    sessions: SessionRepository;
    organizations: OrganizationRepository;
    projects: ProjectRepository;
    scripts: ScriptRepository;
    assets: AssetRepository;
    generations: GenerationRepository;
    jobs: JobRepository;
    exports: ExportRepository;
    templates: TemplateRepository;
    usage: UsageRepository;
    audit: AuditRepository;
    notifications: NotificationRepository;
    scenes: SceneRepository;
    deletionRequests: DeletionRequestRepository;
  };

  services: {
    audit: AuditService;
    authorization: AuthorizationService;
    auth: AuthService;
    organizations: OrganizationService;
    projects: ProjectService;
    scripts: ScriptService;
    scenes: SceneService;
    assets: AssetService;
    generations: GenerationService;
    exports: ExportService;
    templates: TemplateService;
    usage: UsageService;
    notifications: NotificationService;
    deletion: DeletionService;
  };
}

let container: Container | null = null;

/** Builds the application graph. Safe to call once per process. */
export function buildContainer(): Container {
  if (container) return container;

  const config = getConfig();

  const storage = createObjectStorage(config.storage);
  const mailer = createMailer(config.email);
  const media = createMediaProcessor(config.media);
  const providers = createProviderRegistry(config.ai);

  const repositories = {
    users: new UserRepository(),
    sessions: new SessionRepository(),
    organizations: new OrganizationRepository(),
    projects: new ProjectRepository(),
    scripts: new ScriptRepository(),
    assets: new AssetRepository(),
    generations: new GenerationRepository(),
    jobs: new JobRepository(),
    exports: new ExportRepository(),
    templates: new TemplateRepository(),
    usage: new UsageRepository(),
    audit: new AuditRepository(),
    notifications: new NotificationRepository(),
    scenes: new SceneRepository(),
    deletionRequests: new DeletionRequestRepository(),
  };

  const queue = createQueue({
    redisUrl: config.redisUrl,
    prefix: config.worker.queuePrefix,
    defaultMaxAttempts: config.worker.maxAttempts,
    defaultBackoffMs: config.worker.backoffMs,
    jobs: repositories.jobs,
  });

  // The request-aware audit service is constructed first because every other
  // service writes through it: it enriches records with the correlation id, the
  // client address and the actor resolved from the request context, and redacts
  // metadata before it is persisted.
  const auditService = new AuditService(repositories.audit);

  const services = {
    audit: auditService,
    authorization: new AuthorizationService(
      repositories.organizations,
      repositories.projects,
      repositories.users,
    ),
    notifications: new NotificationService(repositories.notifications),
    usage: new UsageService(repositories.usage, repositories.organizations, config),
    templates: new TemplateService(repositories.templates, auditService),
    deletion: new DeletionService(
      repositories.assets,
      repositories.projects,
      repositories.generations,
      repositories.exports,
      repositories.jobs,
      repositories.organizations,
      repositories.users,
      repositories.deletionRequests,
      auditService,
      storage,
    ),
  } as unknown as Container['services'];

  services.auth = new AuthService(
    repositories.users,
    repositories.sessions,
    repositories.organizations,
    auditService,
    mailer,
    config,
  );

  services.organizations = new OrganizationService(
    repositories.organizations,
    repositories.users,
    auditService,
    mailer,
    config,
  );

  services.projects = new ProjectService({
    projects: repositories.projects,
    scripts: repositories.scripts,
    scenes: repositories.scenes,
    assets: repositories.assets,
    audit: auditService,
  });

  services.scripts = new ScriptService(
    repositories.scripts,
    repositories.projects,
    auditService,
  );

  services.scenes = new SceneService(
    repositories.scenes,
    repositories.projects,
    auditService,
  );

  services.assets = new AssetService(
    repositories.assets,
    repositories.projects,
    storage,
    auditService,
    config.limits.maxUploadBytes,
    queue,
  );

  services.generations = new GenerationService({
    generations: repositories.generations,
    projects: repositories.projects,
    queue,
    providers,
    usage: services.usage,
    audit: services.audit,
    config,
  });

  services.exports = new ExportService({
    exports: repositories.exports,
    projects: repositories.projects,
    scenes: repositories.scenes,
    assets: repositories.assets,
    jobs: repositories.jobs,
    queue,
    storage,
    audit: services.audit,
    config,
  });

  container = {
    config,
    storage,
    mailer,
    queue,
    providers,
    media,
    repositories,
    services,
    /** Releases the process-level resources the graph owns. */
    async close() {
      await queue.close();
      await closePool();
    },
  };

  return container;
}
