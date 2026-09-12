/**
 * Project routes: /api/v1/projects
 *
 * Every handler resolves the organization from the resource itself and then
 * asserts the caller's permission. No handler trusts a client-supplied user id
 * or organization id as proof of access.
 */
import { Router } from 'express';

import {
  addProjectMemberSchema,
  createProjectSchema,
  createSceneSchema,
  duplicateProjectSchema,
  errors,
  listProjectsQuerySchema,
  reorderScenesSchema,
  updateProjectSchema,
  updateSceneSchema,
  uuidSchema,
  type OrgRole,
} from '@zyvano/shared';
import { z } from 'zod';

import type { Container } from '@zyvano/server/container';

import { asyncHandler } from '../http/errors';
import { accepted, created, noContent, ok, okList } from '../http/respond';
import { parseBody, parseParams, parseQuery } from '../http/validate';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth';
import { resolveOrganizationId, resolveProjectOrganization } from '../middleware/organization';

// Route parameters always arrive as an object keyed by the placeholder name.
const projectParams = z.object({ projectId: uuidSchema });
const sceneParams = z.object({ projectId: uuidSchema, sceneId: uuidSchema });
const memberParams = z.object({ projectId: uuidSchema, userId: uuidSchema });

export function createProjectRouter(container: Container): Router {
  const router = Router();
  const { authorization } = container.services;

  router.use(requireAuth);

  /** Lists projects in the caller's active organization. */
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const query = parseQuery(listProjectsQuerySchema, req);
      const organizationId = await resolveOrganizationId(container, req, query.organizationId);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'project:read');

      const result = await container.services.projects.list({
        organizationId,
        status: query.status,
        search: query.search,
        sort: query.sort,
        order: query.order,
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
      const body = parseBody(createProjectSchema, req);
      const organizationId = await resolveOrganizationId(container, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'project:create');

      const project = await container.services.projects.create({
        organizationId,
        ownerId: auth.user.id,
        actorEmail: auth.user.email,
        name: body.name,
        description: body.description ?? null,
        prompt: body.prompt ?? null,
        aspectRatio: body.aspectRatio,
        targetDurationSeconds: body.targetDurationSeconds ?? null,
      });

      created(res, project);
    }),
  );

  router.get(
    '/:projectId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:read');
      ok(res, await container.services.projects.get(projectId, decision.organizationId));
    }),
  );

  router.patch(
    '/:projectId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const body = parseBody(updateProjectSchema, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:update');

      const project = await container.services.projects.update({
        projectId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        fields: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(body.aspectRatio !== undefined ? { aspectRatio: body.aspectRatio } : {}),
          ...(body.targetDurationSeconds !== undefined
            ? { targetDurationSeconds: body.targetDurationSeconds }
            : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        },
      });
      ok(res, project);
    }),
  );

  router.delete(
    '/:projectId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:delete');

      // Deletion is permanent and spans database rows plus stored media, so the
      // caller must echo the project name — a stray requeset cannot delete it.
      const project = await container.services.projects.get(projectId, decision.organizationId);
      const confirmation = req.header('x-zyvano-confirm');
      if (confirmation !== project.name) {
        throw errors.validation(
          'Deleting a project requires the "x-zyvano-confirm" header to match the project name exactly.',
          [{ field: 'x-zyvano-confirm', message: 'Confirmation does not match the project name.' }],
        );
      }

      await container.services.deletion.deleteProject({
        projectId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
      });
      noContent(res);
    }),
  );

  router.post(
    '/:projectId/archive',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:update');
      ok(
        res,
        await container.services.projects.archive({
          projectId,
          organizationId: decision.organizationId,
          actorUserId: auth.user.id,
        }),
      );
    }),
  );

  router.post(
    '/:projectId/duplicate',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const body = parseBody(duplicateProjectSchema, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:create');

      const project = await container.services.projects.duplicate({
        projectId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        name: body.name,
        includeAssets: body.includeAssets,
      });
      created(res, project);
    }),
  );

  /* --------------------------------- members -------------------------------- */

  router.get(
    '/:projectId/members',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:read');
      ok(res, await container.services.projects.listMembers(projectId, decision.organizationId));
    }),
  );

  router.post(
    '/:projectId/members',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const body = parseBody(addProjectMemberSchema, req);
      const decision = await authorization.requireProjectPermission(
        projectId,
        auth.user.id,
        'project:manage_members',
      );

      // Members may only be added if they already belong to the organization:
      // a project membership must never become a path into another tenant.
      const target = await container.repositories.users.findByEmail(body.email);
      if (!target) throw errors.notFound('User');
      const orgRole = await container.repositories.organizations.getRole(
        decision.organizationId,
        target.id,
      );
      if (!orgRole) {
        throw errors.validation(
          'That person is not a member of this workspace yet. Invite them to the workspace first.',
          [{ field: 'email', message: 'Not a workspace member.' }],
        );
      }

      await container.services.projects.addMember({
        projectId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        targetUserId: target.id,
        role: body.role as OrgRole,
      });
      created(res, { projectId, userId: target.id, role: body.role });
    }),
  );

  router.delete(
    '/:projectId/members/:userId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId, userId } = parseParams(memberParams, req);
      const decision = await authorization.requireProjectPermission(
        projectId,
        auth.user.id,
        'project:manage_members',
      );
      await container.services.projects.removeMember({
        projectId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        targetUserId: userId,
      });
      noContent(res);
    }),
  );

  /* ---------------------------------- scenes -------------------------------- */

  router.get(
    '/:projectId/scenes',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:read');
      ok(res, await container.services.scenes.list(projectId, decision.organizationId));
    }),
  );

  router.post(
    '/:projectId/scenes',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const body = parseBody(createSceneSchema, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:update');

      const scene = await container.services.scenes.create({
        projectId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        title: body.title,
        description: body.description ?? null,
        prompt: body.prompt ?? null,
        durationSeconds: body.durationSeconds,
        orderIndex: body.orderIndex,
      });
      created(res, scene);
    }),
  );

  router.patch(
    '/:projectId/scenes/:sceneId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId, sceneId } = parseParams(sceneParams, req);
      const body = parseBody(updateSceneSchema, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:update');

      const scene = await container.services.scenes.update({
        sceneId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        fields: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(body.durationSeconds !== undefined ? { durationSeconds: body.durationSeconds } : {}),
          ...(body.orderIndex !== undefined ? { orderIndex: body.orderIndex } : {}),
        },
      });
      ok(res, scene);
    }),
  );

  router.delete(
    '/:projectId/scenes/:sceneId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId, sceneId } = parseParams(sceneParams, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:update');
      await container.services.scenes.remove({
        sceneId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
      });
      noContent(res);
    }),
  );

  router.post(
    '/:projectId/scenes/reorder',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const body = parseBody(reorderScenesSchema, req);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:update');

      const scenes = await container.services.scenes.reorder({
        projectId,
        organizationId: decision.organizationId,
        actorUserId: auth.user.id,
        sceneIds: body.sceneIds,
      });
      ok(res, scenes);
    }),
  );

  /** Convenience endpoint that resolves a project's owning organization. */
  router.get(
    '/:projectId/access',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { projectId } = parseParams(projectParams, req);
      const organizationId = await resolveProjectOrganization(container, req, projectId);
      const decision = await authorization.requireProjectPermission(projectId, auth.user.id, 'project:read');
      accepted(res, { projectId, organizationId, role: decision.role });
    }),
  );

  return router;
}
