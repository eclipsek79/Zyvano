/**
 * Organization, membership and invitation routes: /api/v1/organizations
 */
import { Router } from 'express';
import { z } from 'zod';

import {
  acceptInvitationSchema,
  createOrganizationSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
  uuidSchema,
  type OrgRole,
} from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';

import { asyncHandler } from '../http/errors';
import { created, noContent, ok } from '../http/respond';
import { parseBody, parseParams } from '../http/validate';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth';
import { resolveOrganizationId } from '../middleware/organization';

const orgParams = z.object({ organizationId: uuidSchema });
const orgMemberParams = z.object({ organizationId: uuidSchema, userId: uuidSchema });
const orgInviteParams = z.object({ organizationId: uuidSchema, invitationId: uuidSchema });

export function createOrganizationRouter(container: Container): Router {
  const router = Router();
  const { authorization } = container.services;

  router.use(requireAuth);

  /** Every workspace the caller belongs to. */
  router.get('/', asyncHandler(async (req, res) => {
    const auth = req.auth!;
    ok(res, await authorization.listAccessibleOrganizations(auth.user.id));
  }));

  router.post(
    '/',
    requireVerifiedEmail,
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const body = parseBody(createOrganizationSchema, req);
      const organization = await container.services.organizations.create({
        name: body.name,
        slug: body.slug,
        ownerId: auth.user.id,
        ownerEmail: auth.user.email,
      });
      created(res, organization);
    }),
  );

  router.get(
    '/:organizationId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { organizationId } = parseParams(orgParams, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'org:read');
      ok(res, await container.services.organizations.get(organizationId));
    }),
  );

  router.patch(
    '/:organizationId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { organizationId } = parseParams(orgParams, req);
      const body = parseBody(updateOrganizationSchema, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'org:update');
      ok(
        res,
        await container.services.organizations.update({
          organizationId,
          name: body.name,
          actorUserId: auth.user.id,
        }),
      );
    }),
  );

  router.get(
    '/:organizationId/members',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { organizationId } = parseParams(orgParams, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'org:read');
      ok(res, await container.services.organizations.listMembers(organizationId));
    }),
  );

  router.post(
    '/:organizationId/invitations',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { organizationId } = parseParams(orgParams, req);
      const body = parseBody(inviteMemberSchema, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'org:manage_members');

      const result = await container.services.organizations.invite({
        organizationId,
        email: body.email,
        role: body.role as Exclude<OrgRole, 'owner'>,
        inviterId: auth.user.id,
        inviterName: auth.user.displayName,
      });
      created(res, result);
    }),
  );

  router.get(
    '/:organizationId/invitations',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { organizationId } = parseParams(orgParams, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'org:manage_members');
      ok(res, await container.services.organizations.listInvitations(organizationId));
    }),
  );

  router.delete(
    '/:organizationId/invitations/:invitationId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { organizationId, invitationId } = parseParams(orgInviteParams, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'org:manage_members');
      await container.services.organizations.revokeInvitation({
        organizationId,
        invitationId,
        actorUserId: auth.user.id,
      });
      noContent(res);
    }),
  );

  router.patch(
    '/:organizationId/members/:userId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { organizationId, userId } = parseParams(orgMemberParams, req);
      const body = parseBody(updateMemberRoleSchema, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'org:manage_members');

      await container.services.organizations.changeMemberRole({
        organizationId,
        targetUserId: userId,
        role: body.role as Exclude<OrgRole, 'owner'>,
        actorUserId: auth.user.id,
      });
      noContent(res);
    }),
  );

  router.delete(
    '/:organizationId/members/:userId',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const { organizationId, userId } = parseParams(orgMemberParams, req);
      await authorization.requireOrganizationPermission(organizationId, auth.user.id, 'org:manage_members');
      await container.services.organizations.removeMember({
        organizationId,
        targetUserId: userId,
        actorUserId: auth.user.id,
      });
      noContent(res);
    }),
  );

  /** Accepts a workspace invitation for the authenticated account. */
  router.post(
    '/invitations/accept',
    asyncHandler(async (req, res) => {
      const auth = req.auth!;
      const body = parseBody(acceptInvitationSchema, req);
      const organization = await container.services.organizations.acceptInvitation({
        token: body.token,
        userId: auth.user.id,
        userEmail: auth.user.email,
      });
      ok(res, organization);
    }),
  );

  /** Convenience: resolves the active organization for the caller. */
  router.get('/active/current', asyncHandler(async (req, res) => {
    const organizationId = await resolveOrganizationId(container, req);
    ok(res, await container.services.organizations.get(organizationId));
  }));

  return router;
}
