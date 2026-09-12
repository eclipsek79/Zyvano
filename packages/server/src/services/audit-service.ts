/**
 * Audit trail writer.
 *
 * Audit writes must never break the operation they describe, so failures are
 * logged and swallowed. Metadata is passed through the logger's redactor so a
 * caller cannot accidentally persist a secret into the audit table.
 */
import type { AuditCategory } from '@zyvano/shared';

import { redact } from '../observability/logger';
import { logger } from '../observability/logger';
import { getRequestContext } from '../observability/request-context';
import type { AuditRepository } from '../repositories/audit-repository';

export interface AuditInput {
  organizationId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  category: AuditCategory;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  /**
   * Records an audit event. Request-scoped values (ip, user agent, request id)
   * are filled in automatically from the async request context when available.
   */
  async record(input: AuditInput): Promise<void> {
    const context = getRequestContext();
    try {
      await this.repository.record({
        organizationId: input.organizationId ?? context?.organizationId ?? null,
        actorUserId: input.actorUserId ?? context?.userId ?? null,
        actorEmail: input.actorEmail ?? null,
        category: input.category,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        ipAddress: context?.ipAddress ?? null,
        userAgent: context?.userAgent ?? null,
        requestId: context?.requestId ?? null,
        metadata: (redact(input.metadata ?? {}) as Record<string, unknown>) ?? {},
      });
    } catch (error) {
      logger.error({ err: error, action: input.action }, 'failed to write audit event');
    }
  }

  async listForOrganization(input: {
    organizationId: string;
    category?: string | undefined;
    action?: string | undefined;
    resourceId?: string | undefined;
    page: number;
    perPage: number;
  }) {
    return this.repository.list(input);
  }

  async recent(organizationId: string, limit = 20) {
    return this.repository.recentForOrganization(organizationId, limit);
  }
}
