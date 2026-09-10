/** Scenes: the executable unit of the video pipeline. */
import { errors, type SceneDTO } from '@zyvano/shared';

import { toSceneDTO } from '../db/mappers';
import { withTransaction } from '../db/pool';
import type { AuditService } from './audit-service';
import type { ProjectRepository } from '../repositories/project-repository';
import type { SceneRepository } from '../repositories/scene-repository';

export class SceneService {
  constructor(
    private readonly scenes: SceneRepository,
    private readonly projects: ProjectRepository,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(projectId: string, organizationId: string): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project || project.organization_id !== organizationId) throw errors.notFound('Project');
  }

  async list(projectId: string, organizationId: string): Promise<SceneDTO[]> {
    await this.assertProject(projectId, organizationId);
    return this.scenes.listByProject(projectId);
  }

  async create(input: {
    projectId: string;
    organizationId: string;
    actorUserId: string;
    title: string;
    description?: string | null | undefined;
    prompt?: string | null | undefined;
    durationSeconds: number;
    orderIndex?: number | undefined;
  }): Promise<SceneDTO> {
    await this.assertProject(input.projectId, input.organizationId);
    const row = await this.scenes.create({
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? null,
      prompt: input.prompt ?? null,
      durationSeconds: input.durationSeconds,
      orderIndex: input.orderIndex,
    });
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'scene.created',
      resourceType: 'scene',
      resourceId: row.id as string,
      metadata: { projectId: input.projectId },
    });
    return toSceneDTO(row);
  }

  async update(input: {
    sceneId: string;
    organizationId: string;
    actorUserId: string;
    fields: {
      title?: string;
      description?: string | null;
      prompt?: string | null;
      durationSeconds?: number;
      orderIndex?: number;
    };
  }): Promise<SceneDTO> {
    const existing = await this.scenes.findById(input.sceneId);
    if (!existing) throw errors.notFound('Scene');
    await this.assertProject(existing.project_id as string, input.organizationId);

    const row = await this.scenes.update(input.sceneId, input.fields);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'scene.updated',
      resourceType: 'scene',
      resourceId: input.sceneId,
      metadata: { fields: Object.keys(input.fields) },
    });
    return toSceneDTO(row!);
  }

  async remove(input: { sceneId: string; organizationId: string; actorUserId: string }): Promise<void> {
    const existing = await this.scenes.findById(input.sceneId);
    if (!existing) throw errors.notFound('Scene');
    await this.assertProject(existing.project_id as string, input.organizationId);
    await this.scenes.delete(input.sceneId);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'scene.deleted',
      resourceType: 'scene',
      resourceId: input.sceneId,
    });
  }

  /**
   * Persists an explicit ordering. Runs in one transaction so a partial reorder
   * can never leave the timeline in a half-applied state.
   */
  async reorder(input: {
    projectId: string;
    organizationId: string;
    actorUserId: string;
    sceneIds: string[];
  }): Promise<SceneDTO[]> {
    await this.assertProject(input.projectId, input.organizationId);

    const existing = await this.scenes.listByProject(input.projectId);
    const existingIds = new Set(existing.map((scene) => scene.id));
    for (const sceneId of input.sceneIds) {
      if (!existingIds.has(sceneId)) {
        throw errors.validation('One or more scenes do not belong to this project.');
      }
    }

    await withTransaction(async (client) => {
      await this.scenes.reorder(client, input.projectId, input.sceneIds);
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'scene.reordered',
      resourceType: 'project',
      resourceId: input.projectId,
      metadata: { count: input.sceneIds.length },
    });

    return this.scenes.listByProject(input.projectId);
  }
}
