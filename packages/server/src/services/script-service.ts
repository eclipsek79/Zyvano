/** Scripts and storyboards. */
import { errors, type ScriptDTO, type StoryboardDTO, type StoryboardShot } from '@zyvano/shared';

import { toScriptDTO, toStoryboardDTO, type Row } from '../db/mappers';
import type { AuditService } from './audit-service';
import type { ProjectRepository } from '../repositories/project-repository';
import type { ScriptRepository } from '../repositories/script-repository';

async function assertProjectInOrg(
  projects: ProjectRepository,
  projectId: string,
  organizationId: string,
): Promise<void> {
  const project = await projects.findById(projectId);
  if (!project || project.organization_id !== organizationId) throw errors.notFound('Project');
}

export class ScriptService {
  constructor(
    private readonly scripts: ScriptRepository,
    private readonly projects: ProjectRepository,
    private readonly audit: AuditService,
  ) {}

  async create(input: {
    projectId: string;
    organizationId: string;
    actorUserId: string;
    title: string;
    content: string;
    tone?: string | null | undefined;
    language: string;
  }): Promise<ScriptDTO> {
    await assertProjectInOrg(this.projects, input.projectId, input.organizationId);
    const row = await this.scripts.create({
      projectId: input.projectId,
      title: input.title,
      content: input.content,
      tone: input.tone ?? null,
      language: input.language,
      createdBy: input.actorUserId,
    });
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'script.created',
      resourceType: 'script',
      resourceId: row.id as string,
      metadata: { projectId: input.projectId, version: row.version },
    });
    return toScriptDTO(row);
  }

  async list(projectId: string, organizationId: string): Promise<ScriptDTO[]> {
    await assertProjectInOrg(this.projects, projectId, organizationId);
    return this.scripts.listForProject(projectId);
  }

  async latest(projectId: string, organizationId: string): Promise<ScriptDTO | null> {
    await assertProjectInOrg(this.projects, projectId, organizationId);
    return this.scripts.latestForProject(projectId);
  }

  async update(input: {
    scriptId: string;
    organizationId: string;
    actorUserId: string;
    fields: { title?: string; content?: string; tone?: string | null; language?: string };
  }): Promise<ScriptDTO> {
    const existing = await this.scripts.findById(input.scriptId);
    if (!existing) throw errors.notFound('Script');
    await assertProjectInOrg(this.projects, existing.project_id as string, input.organizationId);

    const row = await this.scripts.update(input.scriptId, input.fields);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'script.updated',
      resourceType: 'script',
      resourceId: input.scriptId,
      metadata: { fields: Object.keys(input.fields) },
    });
    return toScriptDTO(row!);
  }

  async remove(input: { scriptId: string; organizationId: string; actorUserId: string }): Promise<void> {
    const existing = await this.scripts.findById(input.scriptId);
    if (!existing) throw errors.notFound('Script');
    await assertProjectInOrg(this.projects, existing.project_id as string, input.organizationId);
    await this.scripts.delete(input.scriptId);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'destructive',
      action: 'script.deleted',
      resourceType: 'script',
      resourceId: input.scriptId,
    });
  }

  /* -------------------------------- storyboards ------------------------------ */

  async latestStoryboard(projectId: string, organizationId: string): Promise<StoryboardDTO | null> {
    await assertProjectInOrg(this.projects, projectId, organizationId);
    return this.scripts.latestStoryboardForProject(projectId);
  }

  async listStoryboards(projectId: string, organizationId: string): Promise<StoryboardDTO[]> {
    await assertProjectInOrg(this.projects, projectId, organizationId);
    return this.scripts.listStoryboardsForProject(projectId);
  }

  async updateStoryboard(input: {
    storyboardId: string;
    organizationId: string;
    actorUserId: string;
    fields: { title?: string; shots?: StoryboardShot[] };
  }): Promise<StoryboardDTO> {
    const existing = await this.scripts.findStoryboardById(input.storyboardId);
    if (!existing) throw errors.notFound('Storyboard');
    await assertProjectInOrg(this.projects, existing.project_id as string, input.organizationId);

    const row = await this.scripts.updateStoryboard(input.storyboardId, input.fields);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'project',
      action: 'storyboard.updated',
      resourceType: 'storyboard',
      resourceId: input.storyboardId,
      metadata: { fields: Object.keys(input.fields) },
    });
    return toStoryboardDTO(row as Row);
  }
}
