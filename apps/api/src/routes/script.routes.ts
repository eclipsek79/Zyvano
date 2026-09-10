/**
 * Script and storyboard routes: /api/v1/projects/:projectId/... plus /api/v1/scripts
 *
 * Script generation is queued as a job; the resulting script appears on the
 * project once the worker completes, so these endpoints never fabricate content.
 */
import { Router } from 'express';
import { z } from 'zod';

import {
  createScriptSchema,
  errors,
  generateScriptSchema,
  generateStoryboardSchema,
  listGenerationsQuerySchema,
  updateScriptSchema,
  updateStoryboardSchema,
  uuidSchema,
  type GenerationKind,
} from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';

import { asyncHandler } from '../http/errors';
import { accepted, created, noContent, ok, okList } from '../http/respond';
import { parseBody, parseParams } from '../http/validate';
import { requireAuth } from '../middleware/auth';

const scriptParams = z.object({ scriptId: uuidSchema });
const projectParams = z.object({ projectId: uuidSchema });
const storyboardParams = z.object({ storyboardId: uuidSchema });

export function createScriptRouter(container: Container): Router {
  const router = Router();
  const { authorization } = container.services;

  // Authentication is applied per-route rather than router-wide: this router is
  // mounted at the version root, and a router-level guard would swallow requests
  // for paths it does not own and answer them as 401 instead of 404.
  const auth = requireAuth;

  /* ------------------------- scripts within a project ------------------------ */

  router.get(
    '/projects/:projectId/scripts',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:read');
      ok(res, await container.services.scripts.list(projectId, decision.organizationId));
    }),
  );

  router.post(
    '/projects/:projectId/scripts',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const body = parseBody(createScriptSchema, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:update');

      const script = await container.services.scripts.create({
        projectId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        title: body.title,
        content: body.content,
        tone: body.tone ?? null,
        language: body.language,
      });
      created(res, script);
    }),
  );

  /** Queues AI script generation for the project. Returns 202 with the job. */
  router.post(
    '/projects/:projectId/scripts/generate',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const body = parseBody(generateScriptSchema, req);
      const decision = await authorization.requireProjectPermission(
        projectId,
        auth.user.id,
        'generation:create',
      );

      const { generation, deduplicated } = await container.services.generations.create({
        organizationId: decision.organizationId,
        projectId,
        requestedBy: auth.user.id,
        kind: 'script',
        prompt: body.prompt,
        parameters: {
          tone: body.tone ?? null,
          language: body.language,
          targetDurationSeconds: body.targetDurationSeconds ?? null,
        },
        idempotencyKey: body.idempotencyKey,
      });

      // 202: the work is accepted, not done. The client polls the generation.
      accepted(res, { generation, deduplicated });
    }),
  );

  /** Queues storyboard generation, optionally derived from an existing script. */
  router.post(
    '/projects/:projectId/storyboards/generate',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const body = parseBody(generateStoryboardSchema, req);
      const decision = await authorization.requireProjectPermission(
        projectId,
        auth.user.id,
        'generation:create',
      );

      const { generation, deduplicated } = await container.services.generations.create({
        organizationId: decision.organizationId,
        projectId,
        requestedBy: auth.user.id,
        kind: 'storyboard',
        prompt: 'storyboard',
        parameters: {
          scriptId: body.scriptId ?? null,
          sceneCount: body.sceneCount,
        },
        idempotencyKey: body.idempotencyKey,
      });
      accepted(res, { generation, deduplicated });
    }),
  );

  router.get(
    '/projects/:projectId/storyboards',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:read');
      ok(res, await container.services.scripts.listStoryboards(projectId, decision.organizationId));
    }),
  );

  /* ---------------------------- scripts by id ------------------------------- */

  router.patch(
    '/scripts/:scriptId',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { scriptId } = parseParams(scriptParams, req);
      const body = parseBody(updateScriptSchema, req);

      const existing = await container.repositories.scripts.findById(scriptId);
      if (!existing) throw errors.notFound('Script');
      const decision = await authorization.requireProjectPermission(
        existing.project_id as string,
        auth.user.id,
        'project:update',
      );

      const script = await container.services.scripts.update({
        scriptId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        fields: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.content !== undefined ? { content: body.content } : {}),
          ...(body.tone !== undefined ? { tone: body.tone } : {}),
          ...(body.language !== undefined ? { language: body.language } : {}),
        },
      });
      ok(res, script);
    }),
  );

  router.delete(
    '/scripts/:scriptId',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { scriptId } = parseParams(scriptParams, req);
      const existing = await container.repositories.scripts.findById(scriptId);
      if (!existing) throw errors.notFound('Script');
      const decision = await authorization.requireProjectPermission(
        existing.project_id as string,
        auth.user.id,
        'project:update',
      );
      await container.services.scripts.remove({
        scriptId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
      });
      noContent(res);
    }),
  );

  router.patch(
    '/storyboards/:storyboardId',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { storyboardId } = parseParams(storyboardParams, req);
      const body = parseBody(updateStoryboardSchema, req);

      const existing = await container.repositories.scripts.findStoryboardById(storyboardId);
      if (!existing) throw errors.notFound('Storyboard');
      const decision = await authorization.requireProjectPermission(
        existing.project_id as string,
        auth.user.id,
        'project:update',
      );

      const storyboard = await container.services.scripts.updateStoryboard({
        storyboardId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        fields: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.shots !== undefined ? { shots: body.shots } : {}),
        },
      });
      ok(res, storyboard);
    }),
  );

  /** Generation history for a project (scripts, storyboards, scenes, media). */
  router.get(
    '/projects/:projectId/generations',
    auth,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const query = listGenerationsQuerySchema.parse(req.query);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'generation:read');

      const result = await container.services.generations.list({
        organizationId: decision.organizationId,
        projectId,
        status: query.status,
        kind: query.kind as GenerationKind | undefined,
        page: query.page,
        perPage: query.perPage,
      });
      okList(res, result.items, { page: query.page, perPage: query.perPage, total: result.total });
    }),
  );

  return router;
}
