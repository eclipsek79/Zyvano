/**
 * Supporting routes: templates, usage, audit, notifications, jobs, users.
 * All are organization-scoped and permission-checked.
 */
import { Router } from 'express';

import {
  deleteAccountSchema,
  listAuditQuerySchema,
  listTemplatesQuerySchema,
  updateProfileSchema,
  usageSummaryQuerySchema,
  uuidSchema,
} from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';
import { errors } from '@zyvano/shared';

import { asyncHandler } from '../http/errors';
import { accepted, noContent, ok, okList } from '../http/respond';
import { parseBody, parseQuery } from '../http/validate';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth';
import { resolveOrganizationId } from '../middleware/organization';

export function createTemplateRouter(container: Container): Router {
  const router = Router();
  const { authorization } = container.services;
  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const query = parseQuery(listTemplatesQuerySchema, req);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'template:read');

      const result = await container.services.templates.list({
        organizationId,
        category: query.category,
        page: query.page,
        perPage: query.perPage,
      });
      okList(res, result.items, { page: query.page, perPage: query.perPage, total: result.total });
    }),
  );

  router.get(
    '/:templateId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const templateId = uuidSchema.parse(req.params.templateId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'template:read');
      ok(res, await container.services.templates.get(templateId, organizationId));
    }),
  );

  return router;
}

export function createUsageRouter(container: Container): Router {
  const router = Router();
  const { authorization } = container.services;
  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const query = parseQuery(usageSummaryQuerySchema, req);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'usage:read');
      ok(res, await container.services.usage.summary({ organizationId, days: query.days }));
    }),
  );

  router.get(
    '/records',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'usage:read');
      ok(res, await container.services.usage.recent(organizationId, 50));
    }),
  );

  return router;
}

export function createAuditRouter(container: Container): Router {
  const router = Router();
  const { authorization } = container.services;
  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const query = parseQuery(listAuditQuerySchema, req);
      const organizationId = await resolveOrganizationId(container, req);
      // Audit history is administrative: owner/admin only.
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'audit:read');

      const result = await container.services.audit.listForOrganization({
        organizationId,
        category: query.category,
        action: query.action,
        resourceId: query.resourceId,
        page: query.page,
        perPage: query.perPage,
      });
      okList(res, result.items, { page: query.page, perPage: query.perPage, total: result.total });
    }),
  );

  return router;
}

export function createNotificationRouter(container: Container): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      ok(res, await container.services.notifications.list(auth.user.id, 50));
    }),
  );

  router.get(
    '/unread-count',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      ok(res, { count: await container.services.notifications.unreadCount(auth.user.id) });
    }),
  );

  router.post(
    '/:notificationId/read',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const notificationId = uuidSchema.parse(req.params.notificationId);
      await container.services.notifications.markRead(auth.user.id, notificationId);
      noContent(res);
    }),
  );

  router.post(
    '/read-all',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      ok(res, { updated: await container.services.notifications.markAllRead(auth.user.id) });
    }),
  );

  return router;
}

/** Job inspection: lets a user see why an asynchronous operation failed. */
export function createJobRouter(container: Container): Router {
  const router = Router();
  const { authorization } = container.services;
  router.use(requireAuth);

  router.get(
    '/:jobId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const jobId = uuidSchema.parse(req.params.jobId);
      const job = await container.repositories.jobs.findById(jobId);
      if (!job) throw errors.notFound('Job');

      const organizationId = await resolveOrganizationId(container, req);
      if (job.organization_id !== organizationId) throw errors.notFound('Job');
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'generation:read');

      // The job row is returned as-is: an operator needs the failure reason, and
      // error strings are produced by our own workers, never by a provider verbatim.
      ok(res, {
        id: job.id,
        name: job.name,
        queue: job.queue,
        status: job.status,
        progress: job.progress,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        error: job.error_message ?? null,
        generationId: job.generation_id ?? null,
        exportId: job.export_id ?? null,
        projectId: job.project_id ?? null,
        createdAt: new Date(job.created_at as string | Date).toISOString(),
        startedAt: job.started_at ? new Date(job.started_at as string | Date).toISOString() : null,
        finishedAt: job.finished_at ? new Date(job.finished_at as string | Date).toISOString() : null,
      });
    }),
  );

  return router;
}

/** The authenticated user's own account. */
export function createUserRouter(container: Container): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      ok(res, auth.user);
    }),
  );

  router.patch(
    '/me',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const body = parseBody(updateProfileSchema, req);
      await container.repositories.users.updateProfile(auth.user.id, {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      });
      const user = await container.repositories.users.findDTOById(auth.user.id);
      if (!user) throw errors.notFound('User');
      ok(res, user);
    }),
  );

  /**
   * Requests erasure of the authenticated user's account and all data it owns.
   *
   * Three independent gates, because this is the most destructive operation in the
   * product:
   *   1. An authenticated session (`router.use(requireAuth)` above).
   *   2. A verified email address — the account holder must have proved control of the
   *      address, so a stolen session alone cannot destroy the account.
   *   3. A confirmation value that must equal the account's own email address. Typing an
   *      opaque token proves the client sent *a* request; retyping the address proves a
   *      human read what was about to happen.
   *
   * The response is 202 with the durable request id, not 200: the work is queued and
   * has not happened yet. Reporting success here would be the exact kind of claim the
   * platform must never make.
   */
  router.post(
    '/me/deletion-request',
    requireVerifiedEmail,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const body = parseBody(deleteAccountSchema, req);

      const confirmed = body.confirmation.trim().toLowerCase();
      if (confirmed !== auth.user.email.trim().toLowerCase()) {
        throw errors.validation(
          "The confirmation value must exactly match this account's email address.",
          [
            {
              field: 'confirmation',
              message: 'Value does not match the account email address.',
              reason: 'custom',
            },
          ],
        );
      }

      // A request already in flight is returned as-is rather than duplicated: the user
      // would otherwise be able to stack several erasure jobs for one account.
      const existing = await container.repositories.deletionRequests.latestForUser(auth.user.id);
      if (existing && (existing.status === 'pending' || existing.status === 'processing')) {
        accepted(res, {
          id: existing.id,
          scope: existing.scope,
          status: existing.status,
          requestedAt: new Date(existing.created_at as string | Date).toISOString(),
          duplicate: true,
        });
        return;
      }

      const memberships = await container.repositories.organizations.listForUser(auth.user.id);

      const request = await container.repositories.deletionRequests.create({
        scope: 'account',
        userId: auth.user.id,
        organizationId: memberships[0]?.id ?? null,
        reason: body.reason ?? null,
        requestedBy: auth.user.id,
      });

      await container.services.audit.record({
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        category: 'destructive',
        action: 'account.deletion_requested',
        resourceType: 'deletion_request',
        resourceId: request.id,
        metadata: { organizations: memberships.length },
      });

      await container.queue.enqueue(
        'DeleteUserData',
        { deletionRequestId: request.id, userId: auth.user.id },
        {
          organizationId: memberships[0]?.id ?? null,
          dedupeKey: `account-deletion:${auth.user.id}`,
          maxAttempts: 5,
        },
      );

      accepted(res, {
        id: request.id,
        scope: request.scope,
        status: request.status,
        requestedAt: new Date(request.created_at as string | Date).toISOString(),
        duplicate: false,
      });
    }),
  );

  return router;
}
