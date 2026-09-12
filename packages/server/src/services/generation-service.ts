/**
 * Generation orchestration.
 *
 * The API side of generation: validate, authorize-scope, reserve credits, persist
 * the request, then enqueue. Nothing here calls a provider — providers are only
 * invoked inside workers, so an HTTP request never blocks on a render.
 *
 * Lifecycle: queued -> processing -> completed | failed | cancelled. Every
 * transition is persisted in `generations` and mirrored in the durable `jobs` row.
 */
import { randomUUID } from 'node:crypto';

import {
  CAPABILITY_FOR_KIND,
  CREDIT_COSTS,
  JOB_NAMES,
  errors,
  type AICapability,
  type GenerationDTO,
  type GenerationKind,
  type GenerationStatus,
  type JobName,
} from '@zyvano/shared';

import { toGenerationAttemptDTO, toGenerationDTO } from '../db/mappers';
import type { AppConfig } from '../config/env';
import type { ProviderRegistry } from '../infrastructure/ai/registry';
import type { QueueService } from '../infrastructure/queue/queue';
import type { AuditService } from './audit-service';
import type { UsageService } from './usage-service';
import type { GenerationRepository } from '../repositories/generation-repository';
import type { ProjectRepository } from '../repositories/project-repository';

const JOB_FOR_KIND: Record<GenerationKind, JobName> = {
  script: JOB_NAMES.GENERATE_SCRIPT,
  storyboard: JOB_NAMES.GENERATE_STORYBOARD,
  scene: JOB_NAMES.GENERATE_SCENE,
  image: JOB_NAMES.GENERATE_IMAGE,
  video: JOB_NAMES.GENERATE_VIDEO,
  voice: JOB_NAMES.GENERATE_VOICE,
  // Audio generation reuses the voice job; the worker reads the capability from
  // the persisted generation row.
  audio: JOB_NAMES.GENERATE_VOICE,
};

export interface GenerationServiceDeps {
  generations: GenerationRepository;
  projects: ProjectRepository;
  queue: QueueService;
  providers: ProviderRegistry;
  usage: UsageService;
  audit: AuditService;
  config: AppConfig;
}

export interface CreateGenerationInput {
  organizationId: string;
  projectId: string;
  sceneId?: string | null;
  requestedBy: string;
  kind: GenerationKind;
  prompt: string;
  parameters?: Record<string, unknown>;
  provider?: string | undefined;
  model?: string | undefined;
  idempotencyKey?: string | undefined;
}

export class GenerationService {
  constructor(private readonly deps: GenerationServiceDeps) {}

  /**
   * Creates and enqueues a generation request.
   *
   * Idempotency: when the caller supplies a key that already produced a
   * generation in this organization, the existing record is returned untouched,
   * so a retried HTTP request cannot double-charge or double-render.
   */
  async create(input: CreateGenerationInput): Promise<{ generation: GenerationDTO; deduplicated: boolean }> {
    const project = await this.deps.projects.findById(input.projectId);
    if (!project || project.organization_id !== input.organizationId) {
      throw errors.notFound('Project');
    }

    if (input.idempotencyKey) {
      const existing = await this.deps.generations.findByIdempotencyKey(
        input.organizationId,
        input.idempotencyKey,
      );
      if (existing) {
        return { generation: toGenerationDTO(existing), deduplicated: true };
      }
    }

    const capability = CAPABILITY_FOR_KIND[input.kind];
    const provider = this.deps.providers;

    // Fail fast (and charge nothing) when the deployment has no credentials for
    // this capability, instead of queueing a job that is guaranteed to fail.
    const adapter = this.adapterFor(capability, provider, input.provider);
    if (!adapter.isConfigured()) {
      throw errors.providerNotConfigured(adapter.id, capability);
    }

    // Credits are reserved before dispatch from the shared cost table, so the
    // client, the API and the worker cannot disagree about what a kind costs.
    const credits = CREDIT_COSTS[input.kind];
    await this.deps.usage.reserve({ organizationId: input.organizationId, credits });

    const generation = await this.deps.generations.create({
      organizationId: input.organizationId,
      projectId: input.projectId,
      sceneId: input.sceneId ?? null,
      requestedBy: input.requestedBy,
      kind: input.kind,
      capability,
      provider: adapter.id,
      model: input.model ?? null,
      prompt: input.prompt,
      parameters: input.parameters ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      creditsReserved: credits,
    });

    try {
      await this.deps.queue.enqueue(
        JOB_FOR_KIND[input.kind],
        {
          generationId: generation.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          sceneId: input.sceneId ?? null,
        },
        {
          dedupeKey: input.idempotencyKey,
          organizationId: input.organizationId,
          projectId: input.projectId,
          generationId: generation.id as string,
          maxAttempts: this.deps.config.worker.maxAttempts,
        },
      );
    } catch (error) {
      // The job could not be queued (queue unavailable). Refund and fail the
      // generation so the ledger and the UI stay truthful.
      await this.deps.usage.release({ organizationId: input.organizationId, credits });
      await this.deps.generations.markFailed({
        id: generation.id as string,
        errorCode: 'QUEUE_UNAVAILABLE',
        errorMessage: error instanceof Error ? error.message : 'Job queue unavailable.',
      });
      throw errors.infrastructure('The generation queue is unavailable. Please retry shortly.');
    }

    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.requestedBy,
      category: 'generation',
      action: 'generation.created',
      resourceType: 'generation',
      resourceId: generation.id as string,
      metadata: { kind: input.kind, provider: adapter.id, creditsReserved: credits },
    });

    return { generation: toGenerationDTO(generation), deduplicated: false };
  }

  async list(input: {
    organizationId: string;
    projectId?: string | undefined;
    status?: GenerationStatus | undefined;
    kind?: GenerationKind | undefined;
    page: number;
    perPage: number;
  }): Promise<{ items: GenerationDTO[]; total: number }> {
    if (input.projectId) {
      const project = await this.deps.projects.findById(input.projectId);
      if (!project || project.organization_id !== input.organizationId) {
        throw errors.notFound('Project');
      }
    }
    return this.deps.generations.list(input);
  }

  async get(input: {
    generationId: string;
    organizationId: string;
    includeAttempts: boolean;
  }): Promise<GenerationDTO> {
    const row = await this.deps.generations.findByIdInOrganization(
      input.generationId,
      input.organizationId,
    );
    if (!row) throw errors.notFound('Generation');

    const dto = toGenerationDTO(row);
    if (!input.includeAttempts) return dto;

    const attempts = await this.deps.generations.listAttempts(input.generationId);
    return { ...dto, attempts: attempts.map(toGenerationAttemptDTO) };
  }

  /**
   * Cancels a generation. A queued job is removed from the queue; a job already
   * running is marked cancelled, and the worker checks that flag before
   * persisting its result, so a late result cannot resurrect a cancelled row.
   */
  async cancel(input: {
    generationId: string;
    organizationId: string;
    actorUserId: string;
  }): Promise<GenerationDTO> {
    const row = await this.deps.generations.findByIdInOrganization(
      input.generationId,
      input.organizationId,
    );
    if (!row) throw errors.notFound('Generation');

    if (row.status === 'completed' || row.status === 'failed') {
      throw errors.conflict(`A ${row.status} generation cannot be cancelled.`);
    }

    const cancelled = await this.deps.generations.cancel(input.generationId);
    if (!cancelled) {
      throw errors.conflict('This generation has already finished.');
    }

    // Return the reservation. A cancelled generation never produced a billable
    // provider result, and without this the workspace would keep paying for work it
    // explicitly stopped.
    const reserved = Number(row.credits_reserved ?? 0);
    if (reserved > 0) {
      await this.deps.usage.release({ organizationId: input.organizationId, credits: reserved });
    }

    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'generation',
      action: 'generation.cancelled',
      resourceType: 'generation',
      resourceId: input.generationId,
    });

    return this.get({
      generationId: input.generationId,
      organizationId: input.organizationId,
      includeAttempts: false,
    });
  }

  /**
   * Re-runs a failed generation as a brand new record, preserving the original as
   * history. Credits are reserved again because the provider bill is incurred again.
   */
  async retry(input: {
    generationId: string;
    organizationId: string;
    actorUserId: string;
  }): Promise<GenerationDTO> {
    const row = await this.deps.generations.findByIdInOrganization(
      input.generationId,
      input.organizationId,
    );
    if (!row) throw errors.notFound('Generation');

    if (row.status !== 'failed' && row.status !== 'cancelled') {
      throw errors.conflict('Only failed or cancelled generations can be retried.');
    }

    const { generation } = await this.create({
      organizationId: input.organizationId,
      projectId: row.project_id as string,
      sceneId: (row.scene_id as string | null) ?? null,
      requestedBy: input.actorUserId,
      kind: row.kind as GenerationKind,
      prompt: (row.prompt as string | null) ?? '',
      parameters: (row.parameters as Record<string, unknown>) ?? {},
      provider: (row.provider as string | null) || undefined,
      model: (row.model as string | null) || undefined,
      idempotencyKey: `retry:${input.generationId}:${randomUUID()}`,
    });

    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'generation',
      action: 'generation.retried',
      resourceType: 'generation',
      resourceId: generation.id,
      metadata: { previousGenerationId: input.generationId },
    });

    return generation;
  }

  /** Adapter lookup used for the pre-flight configuration check. */
  private adapterFor(
    capability: AICapability,
    registry: ProviderRegistry,
    providerId?: string,
  ): { id: string; isConfigured: () => boolean } {
    switch (capability) {
      case 'text':
        return registry.text(providerId);
      case 'image':
        return registry.image(providerId);
      case 'video':
        return registry.video(providerId);
      case 'voice':
        return registry.voice(providerId);
      case 'audio':
        return registry.audio(providerId);
    }
  }
}

export { JOB_FOR_KIND };
