/**
 * Export routes: /api/v1/exports
 *
 * An export is only presented as downloadable once the render worker has
 * written the file AND verified it exists in storage.
 */
import { Router } from 'express';

import {
  createExportSchema,
  listExportsQuerySchema,
  uuidSchema,
  type ExportPreset,
} from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';

import { asyncHandler } from '../http/errors';
import { accepted, ok, okList } from '../http/respond';
import { parseBody, parseQuery } from '../http/validate';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth';
import { resolveOrganizationId, resolveProjectOrganization } from '../middleware/organization';
import { createRateLimiters } from '../http/rate-limit';

export function createExportRouter(
  container: Container,
  limiters: ReturnType<typeof createRateLimiters>,
): Router {
  const router = Router();
  const { authorization } = container.services;
  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const query = parseQuery(listExportsQuerySchema, req);
      const organizationId = query.projectId
        ? await resolveProjectOrganization(container, req, query.projectId)
        : await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'export:read');
      if (query.projectId) {
        await authorization.requireProjectPermission(query.projectId, auth.user.id, 'export:read');
      }

      const result = await container.services.exports.list({
        organizationId,
        projectId: query.projectId,
        status: query.status,
        page: query.page,
        perPage: query.perPage,
      });
      okList(res, result.items, { page: query.page, perPage: query.perPage, total: result.total });
    }),
  );

  /** Queues a render for a project. Returns 202 with the export record. */
  router.post(
    '/',
    limiters.generation,
    requireVerifiedEmail,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const body = parseBody(createExportSchema, req);

      const projectId = (req.body as { projectId?: string } | undefined)?.projectId;
      const parsedProjectId = uuidSchema.parse(projectId);
      const decision = await authorization.requireProjectPermission(
        parsedProjectId,
        auth.user.id,
        'export:create',
      );

      const { export: createdExport, deduplicated } = await container.services.exports.create({
        organizationId: decision.organizationId,
        projectId: parsedProjectId,
        requestedBy: auth.user.id,
        preset: body.preset as ExportPreset,
        format: body.format,
        includeAudio: body.includeAudio,
        idempotencyKey: body.idempotencyKey,
      });

      accepted(res, { export: createdExport, deduplicated });
    }),
  );

  router.get(
    '/:exportId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const exportId = uuidSchema.parse(req.params.exportId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'export:read');
      ok(res, await container.services.exports.get({ exportId, organizationId }));
    }),
  );

  /**
   * Download gate. Returns a short-lived URL, or an error explaining exactly why
   * the export is not downloadable yet.
   */
  router.get(
    '/:exportId/download',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const exportId = uuidSchema.parse(req.params.exportId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'export:read');
      ok(
        res,
        await container.services.exports.getDownload({
          exportId,
          organizationId,
          actorUserId: auth.user.id,
        }),
      );
    }),
  );

  /**
   * Serves the rendered export bytes from this API.
   *
   * `GET /:exportId/download` returns the URL the client should fetch. On a deployment
   * with an object-storage origin that is a presigned URL served by the storage service.
   * On a deployment using the local filesystem driver there is no such origin, so the
   * download URL points here instead and the bytes are streamed through this handler —
   * which re-runs the same authorization and the same exists-and-verified gate, so the
   * file is never served to someone who could not already download it.
   *
   * `?download=1` sends the file as an attachment for saving; without it the bytes are
   * served inline, which is what a preview element in the client needs.
   */
  router.get(
    '/:exportId/file',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const exportId = uuidSchema.parse(req.params.exportId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'export:read');

      const file = await container.services.exports.readFile({
        exportId,
        organizationId,
        actorUserId: auth.user.id,
      });

      res.setHeader('content-type', file.mimeType);
      res.setHeader('content-length', String(file.buffer.byteLength));
      res.setHeader('cache-control', 'private, no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      const disposition = req.query.download === '1' ? 'attachment' : 'inline';
      res.setHeader(
        'content-disposition',
        `${disposition}; filename="${file.filename.replace(/["\\\r\n]/g, '')}"`,
      );
      res.status(200).send(file.buffer);
    }),
  );

  router.post(
    '/:exportId/cancel',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const exportId = uuidSchema.parse(req.params.exportId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'export:delete');
      ok(
        res,
        await container.services.exports.cancel({ exportId, organizationId, actorUserId: auth.user.id }),
      );
    }),
  );

  router.post(
    '/:exportId/retry',
    limiters.generation,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const exportId = uuidSchema.parse(req.params.exportId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'export:create');
      accepted(
        res,
        await container.services.exports.retry({ exportId, organizationId, actorUserId: auth.user.id }),
      );
    }),
  );

  return router;
}
