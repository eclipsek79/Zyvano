/**
 * Project lifecycle.
 *
 * A project is the central workspace. Authorization is checked by the route layer
 * before these methods are called; these methods additionally scope every read
 * and write by organization id so a mistake upstream cannot leak data.
 */
import { errors, type ProjectDTO, type SceneDTO } from '@zyvano/shared';

import type { AuditService } from './audit-service';
import type { AssetRepository } from '../repositories/asset-repository';
import type { ProjectRepository } from '../repositories/project-repository';
import type { SceneRepository } from '../repositories/scene-repository';
import type { ScriptRepository } from '../repositories/script-repository';

import { toProjectDTO } from '../db/mappers';

export interface ProjectServiceDeps {
  projects: ProjectRepository;
  scripts: ScriptRepository;
  scenes: SceneRepository;
  assets: AssetRepository;
  audit: AuditService;
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  async create(input: {
    organizationId: string;
    ownerId: string;
    actorEmail: string;
    name: string;
    description?: string | null | undefined;
    prompt?: string | null | undefined;
    aspectRatio: string;
    targetDurationSeconds?: number | null | undefined;
  }): Promise<ProjectDTO> {
    const project = await this.deps.projects.create({
      organizationId: input.organizationId,
      ownerId: input.ownerId,
      name: input.name,
      description: input.description ?? null,
      prompt: input.prompt ?? null,
      aspectRatio: input.aspectRatio,
      targetDurationSeconds: input.targetDurationSeconds ?? null,
    });

    // The creator is recorded as an explicit project member so per-project
    // membership never has to fall back on inference.
    await this.deps.projects.addMember({
      projectId: project.id,
      userId: input.ownerId,
      role: 'owner',
      addedBy: input.ownerId,
    });

    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.ownerId,
      actorEmail: input.actorEmail,
      category: 'project',
      action: 'project.created',
      resourceType: 'project',
      resourceId: project.id,
      metadata: { name: project.name, aspectRatio: project.aspect_ratio },
    });

    return this.get(project.id, input.organizationId);
  }

  async get(projectId: string, organizationId: string): Promise<ProjectDTO> {
    const detail = await this.deps.projects.findDetailById(projectId);
    // Returning NOT_FOUND (rather than FORBIDDEN) for a project in another
    // organization avoids confirming that the id exists at all.
    if (!detail || detail.organizationId !== organizationId) throw errors.notFound('Project');
    return detail;
  }

  async list(input: {
    organizationId: string;
    status?: any;
    search?: string | undefined;
    sort?: string | undefined;
    order?: 'asc' | 'desc' | undefined;
    page: number;
    perPage: number;
  }): Promise<{ items: ProjectDTO[]; total: number }> {
    const result = await this.deps.projects.list(input);
    return { items: result.items, total: result.total };
  }

  async update(input: {
    projectId: string;
    organizationId: string;
    actorUserId: string;
    fields: {
      name?: string;
      description?: string | null;
      prompt?: string | null;
      aspectRatio?: string;
      targetDurationSeconds?: number | null;
      status?: string;
    };
  }): Promise<ProjectDTO> {
    const existing = await this.deps.projects.findById(input.projectId);
    if (!existing || existing.organization_id !== input.organizationId) {
      throw errors.notFound('Project');
    }

    await this.deps.projects.update(input.projectId, input.fields);
    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'project.updated',
      resourceType: 'project',
      resourceId: input.projectId,
      metadata: { fields: Object.keys(input.fields) },
    });
    return this.get(input.projectId, input.organizationId);
  }

  /**
   * Duplicates a project's structure (script, storyboard shots, scenes). Media is
   * not copied by default — assets can be large and are usually regenerated.
   */
  async duplicate(input: {
    projectId: string;
    organizationId: string;
    actorUserId: string;
    actorEmail: string;
    name?: string | undefined;
    includeAssets: boolean;
  }): Promise<ProjectDTO> {
    const source = await this.deps.projects.findById(input.projectId);
    if (!source || source.organization_id !== input.organizationId) {
      throw errors.notFound('Project');
    }

    const copy = await this.deps.projects.create({
      organizationId: input.organizationId,
      ownerId: input.actorUserId,
      name: input.name ?? `${source.name} (copy)`,
      description: source.description,
      prompt: source.prompt,
      aspectRatio: source.aspect_ratio,
      targetDurationSeconds: source.target_duration_seconds,
    });

    await this.deps.projects.addMember({
      projectId: copy.id,
      userId: input.actorUserId,
      role: 'owner',
      addedBy: input.actorUserId,
    });

    const latestScript = await this.deps.scripts.latestForProject(input.projectId);
    if (latestScript) {
      await this.deps.scripts.create({
        projectId: copy.id,
        title: latestScript.title,
        content: latestScript.content,
        tone: latestScript.tone,
        language: latestScript.language,
        createdBy: input.actorUserId,
      });
    }

    const latestStoryboard = await this.deps.scripts.latestStoryboardForProject(input.projectId);
    if (latestStoryboard) {
      await this.deps.scripts.createStoryboard({
        projectId: copy.id,
        title: latestStoryboard.title,
        shots: latestStoryboard.shots,
        createdBy: input.actorUserId,
      });
    }

    const scenes: SceneDTO[] = await this.deps.scenes.listByProject(input.projectId);
    for (const scene of scenes) {
      await this.deps.scenes.create({
        projectId: copy.id,
        title: scene.title,
        description: scene.description,
        prompt: scene.prompt,
        durationSeconds: scene.durationSeconds,
        orderIndex: scene.orderIndex,
      });
    }

    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      category: 'project',
      action: 'project.duplicated',
      resourceType: 'project',
      resourceId: copy.id,
      metadata: { sourceProjectId: input.projectId, scenes: scenes.length, includeAssets: input.includeAssets },
    });

    return this.get(copy.id, input.organizationId);
  }

  /** Archives rather than destroys: archived projects stay recoverable. */
  async archive(input: { projectId: string; organizationId: string; actorUserId: string }): Promise<ProjectDTO> {
    const existing = await this.deps.projects.findById(input.projectId);
    if (!existing || existing.organization_id !== input.organizationId) {
      throw errors.notFound('Project');
    }
    await this.deps.projects.update(input.projectId, { status: 'archived' });
    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'project.archived',
      resourceType: 'project',
      resourceId: input.projectId,
    });
    return this.get(input.projectId, input.organizationId);
  }

  async listScenes(projectId: string, organizationId: string): Promise<SceneDTO[]> {
    const project = await this.deps.projects.findById(projectId);
    if (!project || project.organization_id !== organizationId) throw errors.notFound('Project');
    return this.deps.scenes.listByProject(projectId);
  }

  /* ----------------------------- project members ---------------------------- */

  async listMembers(projectId: string, organizationId: string) {
    const project = await this.deps.projects.findById(projectId);
    if (!project || project.organization_id !== organizationId) throw errors.notFound('Project');
    const rows = await this.deps.projects.listMembers(projectId);
    return rows.map((row) => ({
      userId: row.user_id as string,
      email: row.email as string,
      displayName: row.display_name as string,
      role: row.role,
      addedAt: new Date(row.created_at as string | Date).toISOString(),
    }));
  }

  async addMember(input: {
    projectId: string;
    organizationId: string;
    actorUserId: string;
    targetUserId: string;
    role: any;
  }): Promise<void> {
    const project = await this.deps.projects.findById(input.projectId);
    if (!project || project.organization_id !== input.organizationId) throw errors.notFound('Project');
    await this.deps.projects.addMember({
      projectId: input.projectId,
      userId: input.targetUserId,
      role: input.role,
      addedBy: input.actorUserId,
    });
    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'project.member.added',
      resourceType: 'project',
      resourceId: input.projectId,
      metadata: { targetUserId: input.targetUserId, role: input.role },
    });
  }

  async removeMember(input: {
    projectId: string;
    organizationId: string;
    actorUserId: string;
    targetUserId: string;
  }): Promise<void> {
    const project = await this.deps.projects.findById(input.projectId);
    if (!project || project.organization_id !== input.organizationId) throw errors.notFound('Project');
    if (project.owner_id === input.targetUserId) {
      throw errors.conflict('The project owner cannot be removed from the project.');
    }
    const removed = await this.deps.projects.removeMember(input.projectId, input.targetUserId);
    if (!removed) throw errors.notFound('Project member');
    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'project.member.removed',
      resourceType: 'project',
      resourceId: input.projectId,
      metadata: { targetUserId: input.targetUserId },
    });
  }
}

export { toProjectDTO };
