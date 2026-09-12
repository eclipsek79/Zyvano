/** Organization, membership and invitation management. */
import { errors, ROLE_RANK, type OrgRole, type OrganizationDTO } from '@zyvano/shared';

import type { AppConfig } from '../config/env';
import { generateToken } from '../security/crypto';
import { hashToken } from '../security/session';
import type { Mailer } from '../infrastructure/email/mailer';
import type { AuditService } from './audit-service';
import type { OrganizationRepository } from '../repositories/organization-repository';
import type { UserRepository } from '../repositories/user-repository';
import { toOrganizationDTO } from '../db/mappers';

const INVITE_TTL_DAYS = 14;

export class OrganizationService {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    private readonly config: AppConfig,
  ) {}

  async listForUser(userId: string): Promise<OrganizationDTO[]> {
    return this.organizations.listForUser(userId);
  }

  async get(organizationId: string): Promise<OrganizationDTO> {
    const organization = await this.organizations.findById(organizationId);
    if (!organization) throw errors.notFound('Organization');
    const memberCount = (await this.organizations.listMembers(organizationId)).length;
    return toOrganizationDTO({ ...organization, member_count: memberCount });
  }

  async create(input: { name: string; slug?: string | undefined; ownerId: string; ownerEmail: string }) {
    const slug = input.slug ?? (await this.uniqueSlug(input.name));
    const organization = await this.organizations.create({
      name: input.name,
      slug,
      ownerId: input.ownerId,
    });
    await this.organizations.addMember({
      organizationId: organization.id,
      userId: input.ownerId,
      role: 'owner',
    });
    await this.audit.record({
      organizationId: organization.id,
      actorUserId: input.ownerId,
      actorEmail: input.ownerEmail,
      category: 'admin',
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: organization.id,
    });
    return this.get(organization.id);
  }

  async update(input: { organizationId: string; name?: string | undefined; actorUserId: string }) {
    const updated = await this.organizations.update(input.organizationId, { name: input.name });
    if (!updated) throw errors.notFound('Organization');
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'admin',
      action: 'organization.updated',
      resourceType: 'organization',
      resourceId: input.organizationId,
      metadata: { fields: Object.keys(input).filter((key) => key.endsWith('name')) },
    });
    return this.get(input.organizationId);
  }

  async listMembers(organizationId: string) {
    const rows = await this.organizations.listMembers(organizationId);
    return rows.map((row) => ({
      userId: row.user_id as string,
      email: row.email as string,
      displayName: row.display_name as string,
      role: row.role as OrgRole,
      addedAt: new Date(row.created_at as string | Date).toISOString(),
    }));
  }

  async invite(input: {
    organizationId: string;
    email: string;
    role: Exclude<OrgRole, 'owner'>;
    inviterId: string;
    inviterName: string;
  }): Promise<{ invited: true }> {
    const organization = await this.organizations.findById(input.organizationId);
    if (!organization) throw errors.notFound('Organization');

    // An existing member is updated in place rather than invited twice.
    const existingUser = await this.users.findByEmail(input.email);
    if (existingUser) {
      const existingRole = await this.organizations.getRole(input.organizationId, existingUser.id);
      if (existingRole) {
        await this.organizations.updateMemberRole(input.organizationId, existingUser.id, input.role);
        await this.audit.record({
          organizationId: input.organizationId,
          actorUserId: input.inviterId,
          category: 'admin',
          action: 'organization.member.role_changed',
          resourceType: 'user',
          resourceId: existingUser.id,
          metadata: { from: existingRole, to: input.role },
        });
        return { invited: true };
      }
    }

    const token = generateToken(32);
    await this.organizations.createInvitation({
      organizationId: input.organizationId,
      email: input.email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: input.inviterId,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

    await this.mailer.sendOrganizationInvite({
      to: input.email,
      organizationName: organization.name,
      inviterName: input.inviterName,
      acceptUrl: `${this.config.applicationUrl}/invitations/accept?token=${encodeURIComponent(token)}`,
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.inviterId,
      category: 'admin',
      action: 'organization.member.invited',
      resourceType: 'organization',
      resourceId: input.organizationId,
      metadata: { email: input.email, role: input.role },
    });

    return { invited: true };
  }

  async acceptInvitation(input: { token: string; userId: string; userEmail: string }): Promise<OrganizationDTO> {
    const invitation = await this.organizations.findInvitationByTokenHash(hashToken(input.token));
    if (!invitation) throw errors.validation('This invitation is invalid or has expired.');

    // The invite is bound to an address: a leaked token cannot be used by a
    // different account.
    if (String(invitation.email).toLowerCase() !== input.userEmail.toLowerCase()) {
      throw errors.forbidden('This invitation was issued to a different email address.');
    }

    await this.organizations.addMember({
      organizationId: invitation.organization_id as string,
      userId: input.userId,
      role: invitation.role as OrgRole,
    });
    await this.organizations.acceptInvitation(invitation.id as string);

    await this.audit.record({
      organizationId: invitation.organization_id as string,
      actorUserId: input.userId,
      actorEmail: input.userEmail,
      category: 'admin',
      action: 'organization.member.joined',
      resourceType: 'organization',
      resourceId: invitation.organization_id as string,
      metadata: { role: invitation.role },
    });

    return this.get(invitation.organization_id as string);
  }

  async listInvitations(organizationId: string) {
    const rows = await this.organizations.listInvitations(organizationId);
    return rows.map((row) => ({
      id: row.id as string,
      email: row.email as string,
      role: row.role as OrgRole,
      expiresAt: new Date(row.expires_at as string | Date).toISOString(),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    }));
  }

  async revokeInvitation(input: { organizationId: string; invitationId: string; actorUserId: string }) {
    const removed = await this.organizations.deleteInvitation(input.organizationId, input.invitationId);
    if (!removed) throw errors.notFound('Invitation');
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'admin',
      action: 'organization.member.invitation_revoked',
      resourceId: input.invitationId,
    });
  }

  async changeMemberRole(input: {
    organizationId: string;
    targetUserId: string;
    role: Exclude<OrgRole, 'owner'>;
    actorUserId: string;
  }): Promise<void> {
    const currentRole = await this.organizations.getRole(input.organizationId, input.targetUserId);
    if (!currentRole) throw errors.notFound('Member');

    // Ownership transfer is a dedicated operation; it must not be reachable by
    // simply supplying "owner" to the role-change endpoint.
    if (currentRole === 'owner') {
      throw errors.forbidden('Ownership must be transferred explicitly, not by role change.');
    }

    // A user cannot raise their own privileges.
    if (input.targetUserId === input.actorUserId) {
      throw errors.forbidden('You cannot change your own role.');
    }

    await this.organizations.updateMemberRole(input.organizationId, input.targetUserId, input.role);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'admin',
      action: 'organization.member.role_changed',
      resourceType: 'user',
      resourceId: input.targetUserId,
      metadata: { from: currentRole, to: input.role },
    });
  }

  async removeMember(input: { organizationId: string; targetUserId: string; actorUserId: string }): Promise<void> {
    const role = await this.organizations.getRole(input.organizationId, input.targetUserId);
    if (!role) throw errors.notFound('Member');

    if (role === 'owner') {
      const owners = await this.organizations.countOwners(input.organizationId);
      if (owners <= 1) throw errors.conflict('An organization must keep at least one owner.');
    }

    await this.organizations.removeMember(input.organizationId, input.targetUserId);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'admin',
      action: 'organization.member.removed',
      resourceType: 'user',
      resourceId: input.targetUserId,
    });
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'workspace';
    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`;
      if (!(await this.organizations.slugExists(candidate))) return candidate;
    }
    return `${base}-${generateToken(6).replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;
  }
}

export { ROLE_RANK };
