/** Templates: read access plus organization-owned creation. */
import { errors, type TemplateDTO } from '@zyvano/shared';

import type { AuditService } from './audit-service';
import type { TemplateRepository } from '../repositories/template-repository';

/** Default catalog seeded at startup so a new workspace is never empty. */
export const SYSTEM_TEMPLATES = [
  {
    name: 'Product Launch Teaser',
    slug: 'product-launch-teaser',
    description: 'Punchy 30-second teaser built around a single product hero shot.',
    category: 'marketing',
    aspectRatio: '16:9',
    defaultDurationSeconds: 30,
    definition: {
      sceneCount: 5,
      tone: 'bold, energetic',
      beats: ['hook', 'problem', 'product reveal', 'benefit montage', 'call to action'],
    },
  },
  {
    name: 'Social Story Vertical',
    slug: 'social-story-vertical',
    description: 'Vertical 9:16 story format tuned for short-form social feeds.',
    category: 'social',
    aspectRatio: '9:16',
    defaultDurationSeconds: 15,
    definition: {
      sceneCount: 4,
      tone: 'casual, direct',
      beats: ['attention grab', 'context', 'payoff', 'follow prompt'],
    },
  },
  {
    name: 'Explainer Walkthrough',
    slug: 'explainer-explainer',
    description: 'Structured explainer with narration-led beats.',
    category: 'education',
    aspectRatio: '16:9',
    defaultDurationSeconds: 60,
    definition: {
      sceneCount: 7,
      tone: 'clear, informative',
      beats: ['intro', 'context', 'step 1', 'step 2', 'step 3', 'recap', 'outro'],
    },
  },
  {
    name: 'Brand Atmosphere Loop',
    slug: 'brand-atmosphere-loop',
    description: 'Slow, atmospheric brand loop with minimal narration.',
    category: 'brand',
    aspectRatio: '16:9',
    defaultDurationSeconds: 20,
    definition: {
      sceneCount: 4,
      tone: 'calm, premium',
      beats: ['establishing', 'detail', 'texture', 'logotype'],
    },
  },
] as const;

export class TemplateService {
  constructor(
    private readonly templates: TemplateRepository,
    private readonly audit: AuditService,
  ) {}

  async list(input: {
    organizationId: string;
    category?: string | undefined;
    page: number;
    perPage: number;
  }): Promise<{ items: TemplateDTO[]; total: number }> {
    return this.templates.listForOrganization(input);
  }

  async get(id: string, organizationId: string): Promise<TemplateDTO> {
    const row = await this.templates.findUsableById(id, organizationId);
    if (!row) throw errors.notFound('Template');
    return {
      id: row.id as string,
      organizationId: (row.organization_id as string | null) ?? null,
      name: row.name as string,
      slug: row.slug as string,
      description: (row.description as string | null) ?? null,
      category: row.category as string,
      aspectRatio: row.aspect_ratio as string,
      defaultDurationSeconds: Number(row.default_duration_seconds),
      definition: (row.definition as Record<string, unknown>) ?? {},
      isSystem: Boolean(row.is_system),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    };
  }

  async create(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
    slug: string;
    description?: string | null;
    category: string;
    aspectRatio: string;
    defaultDurationSeconds: number;
    definition: Record<string, unknown>;
  }): Promise<TemplateDTO> {
    const row = await this.templates.create({
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      category: input.category,
      aspectRatio: input.aspectRatio,
      defaultDurationSeconds: input.defaultDurationSeconds,
      definition: input.definition,
      isSystem: false,
      createdBy: input.actorUserId,
    });
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'admin',
      action: 'template.created',
      resourceType: 'template',
      resourceId: row.id as string,
    });
    return this.get(row.id as string, input.organizationId);
  }

  /** Idempotently installs the default catalog. Safe to run on every startup. */
  async seedSystemTemplates(): Promise<void> {
    for (const template of SYSTEM_TEMPLATES) {
      await this.templates.upsertSystemTemplate({
        name: template.name,
        slug: template.slug,
        description: template.description,
        category: template.category,
        aspectRatio: template.aspectRatio,
        defaultDurationSeconds: template.defaultDurationSeconds,
        definition: template.definition as unknown as Record<string, unknown>,
      });
    }
  }
}
