/**
 * Media asset routes: /api/v1/assets
 *
 * Uploads are streamed through busboy with a hard size ceiling and validated
 * server-side before anything is written to storage. Reads and deletes are
 * organization-scoped, so an id from another tenant returns 404.
 */
import { Router } from 'express';
import type { Request } from 'express';
import Busboy from 'busboy';

import {
  listAssetsQuerySchema,
  errors,
  uuidSchema,
  type AssetKind,
} from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';
import { getConfig } from '@zyvano/server/config/env';

import { asyncHandler } from '../http/errors';
import { created, noContent, ok, okList } from '../http/respond';
import { parseQuery } from '../http/validate';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth';
import { resolveOrganizationId } from '../middleware/organization';

interface UploadedFile {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  truncated: boolean;
}

/**
 * Parses exactly one multipart file field named `file`, buffering it in memory
 * up to the configured maximum. Any second file or unexpected field is rejected.
 */
function readSingleUpload(req: Request, maxBytes: number): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    const contentType = req.header('content-type') ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      reject(errors.validation('Uploads must use multipart/form-data.'));
      return;
    }

    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: maxBytes, fields: 4, parts: 5 },
    });

    let file: UploadedFile | null = null;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    busboy.on('file', (fieldName, stream, info) => {
      if (fieldName !== 'file') {
        stream.resume();
        fail(errors.validation('The multipart file field must be named "file".'));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;

      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          truncated = true;
          return;
        }
        chunks.push(chunk);
      });
      stream.on('limit', () => {
        truncated = true;
      });
      stream.on('end', () => {
        file = {
          filename: info.filename || 'upload',
          mimeType: info.mimeType || 'application/octet-stream',
          buffer: Buffer.concat(chunks),
          truncated,
        };
      });
    });

    busboy.on('error', () => fail(errors.badRequest('The upload could not be read.')));
    busboy.on('close', () => {
      if (settled) return;
      if (!file) {
        fail(errors.validation('No file was provided.'));
        return;
      }
      if (file.truncated) {
        fail(errors.payloadTooLarge(`Files must be smaller than ${Math.round(maxBytes / (1024 * 1024))} MB.`));
        return;
      }
      settled = true;
      resolve(file);
    });

    req.pipe(busboy);
  });
}

export function createAssetRouter(container: Container): Router {
  const router = Router();
  const { authorization } = container.services;
  const config = getConfig();
  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const query = parseQuery(listAssetsQuerySchema, req);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'asset:read');

      const result = await container.services.assets.list({
        organizationId,
        projectId: query.projectId,
        kind: query.kind as AssetKind | undefined,
        source: query.source,
        search: query.search,
        page: query.page,
        perPage: query.perPage,
      });
      okList(res, result.items, { page: query.page, perPage: query.perPage, total: result.total });
    }),
  );

  router.post(
    '/',
    requireVerifiedEmail,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'asset:upload');

      const projectId = (req.query.projectId as string | undefined) ?? null;
      if (projectId) {
        const parsed = uuidSchema.safeParse(projectId);
        if (!parsed.success) throw errors.validation('projectId must be a UUID.');
        // Uploading into a project additionally requires write access to it.
        await authorization.requireProjectPermission(projectId, auth.user.id, 'asset:upload');
      }

      const file = await readSingleUpload(req, config.limits.maxUploadBytes);
      const asset = await container.services.assets.upload({
        organizationId,
        projectId,
        ownerId: auth.user.id,
        actorEmail: auth.user.email,
        filename: file.filename,
        mimeType: file.mimeType,
        buffer: file.buffer,
      });
      created(res, asset);
    }),
  );

  router.get(
    '/:assetId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const assetId = uuidSchema.parse(req.params.assetId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'asset:read');
      ok(res, await container.services.assets.get(assetId, organizationId));
    }),
  );

  /**
   * Streams the stored bytes. Access is authorized on every request, which is
   * why the client never receives a raw storage key.
   */
  router.get(
    '/:assetId/content',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const assetId = uuidSchema.parse(req.params.assetId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'asset:read');

      const content = await container.services.assets.readContent(assetId, organizationId);
      res.setHeader('content-type', content.mimeType);
      res.setHeader('cache-control', 'private, max-age=300');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader(
        'content-disposition',
        `inline; filename="${content.filename.replace(/["\\\r\n]/g, '')}"`,
      );
      res.status(200).send(content.buffer);
    }),
  );

  router.delete(
    '/:assetId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const assetId = uuidSchema.parse(req.params.assetId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'asset:delete');
      await container.services.assets.remove({
        assetId,
        organizationId,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
      });
      noContent(res);
    }),
  );

  return router;
}
