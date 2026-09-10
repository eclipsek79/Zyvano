/**
 * Generation routes: /api/v1/generations
 *
 * The API never invents progress. Every field a client renders comes from the
 * persisted generation row, which the worker updates as it talks to providers.
 */
import { Router } from 'express';

import {
  errors,
  generateSceneSchema,
  generateVoiceSchema,
  listGenerationsQuerySchema,
  uuidSchema,
  type GenerationKind,
} from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';

import { asyncHandler } from '../http/errors';
import { accepted, ok, okList } from '../http/respond';
import { parseBody, parseQuery } from '../http/validate';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth';
import { resolveOrganizationId, resolveProjectOrganization } from '../middleware/organization';
import { createRateLimiters } from '../http/rate-limit';

export function createGenerationRouter(
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
      const query = parseQuery(listGenerationsQuerySchema, req);

      // When a project is named the project itself determines the organization,
      // so a mismatched query cannot widen the scope.
      const organizationId = query.projectId
        ? await resolveProjectOrganization(container, req, query.projectId)
        : await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'generation:read');
      if (query.projectId) {
        await authorization.requireProjectPermission(query.projectId, auth.user.id, 'generation:read');
      }

      const result = await container.services.generations.list({
        organizationId,
        projectId: query.projectId,
        status: query.status,
        kind: query.kind as GenerationKind | undefined,
        page: query.page,
        perPage: query.perPage,
      });
      okList(res, result.items, { page: query.page, perPage: query.perPage, total: result.total });
    }),
  );

  /** Queues a scene render (image or video) for a specific scene. */
  router.post(
    '/scenes',
    limiters.generation,
    requireVerifiedEmail,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const body = parseBody(generateSceneSchema, req);

      const scene = await container.repositories.scenes.findById(body.sceneId);
      if (!scene) throw errors.notFound('Scene');
      const projectId = scene.project_id as string;
      const decision = await authorization.requireProjectPermission(
        projectId,
        auth.user.id,
        'generation:create',
      );

      const { generation, deduplicated } = await container.services.generations.create({
        organizationId: decision.organizationId,
        projectId,
        sceneId: body.sceneId,
        requestedBy: auth.user.id,
        kind: body.kind,
        prompt: body.prompt ?? (scene.prompt as string | null) ?? (scene.description as string) ?? '',
        parameters: {
          durationSeconds: body.durationSeconds ?? Math.round(Number(scene.duration_seconds) || 5),
          aspectRatio: null,
        },
        provider: body.provider,
        model: body.model,
        idempotencyKey: body.idempotencyKey,
      });

      accepted(res, { generation, deduplicated });
    }),
  );

  /** Queues voice-over generation. */
  router.post(
    '/voice',
    limiters.generation,
    requireVerifiedEmail,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const body = parseBody(generateVoiceSchema, req);

      // A voice generation is always anchored to a project so quota and audit
      // records have a scope. It may optionally target one scene.
      const sceneId = body.sceneId ?? null;
      const scene = sceneId ? await container.repositories.scenes.findById(sceneId) : null;
      const projectId =
        (scene?.project_id as string | undefined) ?? (req.body?.projectId as string | undefined);
      if (!projectId) {
        throw errors.validation(
          'voice generation requires a sceneId or a projectId.',
          [{ field: 'sceneId', message: 'Provide a scene or a project.' }],
        );
      }

      const decision = await authorization.requireProjectPermission(
        projectId,
        auth.user.id,
        'generation:create',
      );

      const { generation, deduplicated } = await container.services.generations.create({
        organizationId: decision.organizationId,
        projectId,
        sceneId,
        requestedBy: auth.user.id,
        kind: 'voice',
        prompt: body.text,
        parameters: { voiceId: body.voiceId ?? null, language: body.language },
        idempotencyKey: body.idempotencyKey,
      });
      accepted(res, { generation, deduplicated });
    }),
  );

  router.get(
    '/:generationId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const generationId = uuidSchema.parse(req.params.generationId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'generation:read');

      const includeAttempts = req.query.includeAttempts === 'true';
      ok(
        res,
        await container.services.generations.get({ generationId, organizationId, includeAttempts }),
      );
    }),
  );

  router.post(
    '/:generationId/cancel',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const generationId = uuidSchema.parse(req.params.generationId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'generation:cancel');
      ok(
        res,
        await container.services.generations.cancel({
          generationId,
          organizationId,
          actorUserId: auth.user.id,
        }),
      );
    }),
  );

  router.post(
    '/:generationId/retry',
    limiters.generation,
    requireVerifiedEmail,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const generationId = uuidSchema.parse(req.params.generationId);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'generation:create');
      accepted(
        res,
        await container.services.generations.retry({
          generationId,
          organizationId,
          actorUserId: auth.user.id,
        }),
      );
    }),
  );

  return router;
}
