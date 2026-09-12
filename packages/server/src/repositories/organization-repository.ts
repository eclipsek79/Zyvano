/** Organizations, memberships and invitations. */
import { query, queryOne } from '../db/pool';
import { toOrganizationDTO, type Row } from '../db/mappers';
import type { OrganizationDTO, OrgRole } from '@zyvano/shared';

export interface OrganizationRecord extends Row {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
}

export interface MembershipRecord extends Row {
  organization_id: string;
  user_id: string;
  role: OrgRole;
}

export class OrganizationRepository {
  async create(input: {
    name: string;
    slug: string;
    ownerId: string;
    settings?: Record<string, unknown>;
  }): Promise<OrganizationRecord> {
    const row = await queryOne<OrganizationRecord>(
      `INSERT INTO organizations (name, slug, owner_id, settings)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.name, input.slug, input.ownerId, JSON.stringify(input.settings ?? {})],
    );
    return row!;
  }

  async findById(id: string): Promise<OrganizationRecord | null> {
    return queryOne<OrganizationRecord>('SELECT * FROM organizations WHERE id = $1 AND deleted_at IS NULL', [id]);
  }

  async findBySlug(slug: string): Promise<OrganizationRecord | null> {
    return queryOne<OrganizationRecord>('SELECT * FROM organizations WHERE slug = $1 AND deleted_at IS NULL', [slug]);
  }

  async slugExists(slug: string): Promise<boolean> {
    const row = await queryOne<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM organizations WHERE slug = $1) AS exists',
      [slug],
    );
    return row?.exists ?? false;
  }

  /** All organizations the user belongs to, with the user's role attached. */
  async listForUser(userId: string): Promise<OrganizationDTO[]> {
    const rows = await query(
      `SELECT o.*, m.role AS role,
              (SELECT COUNT(*) FROM organization_members om WHERE om.organization_id = o.id) AS member_count
         FROM organizations o
         JOIN organization_members m ON m.organization_id = o.id
        WHERE m.user_id = $1 AND o.deleted_at IS NULL
        ORDER BY o.created_at ASC`,
      [userId],
    );
    return rows.rows.map(toOrganizationDTO);
  }

  /** The caller's role in an organization, or null when not a member. */
  async getRole(organizationId: string, userId: string): Promise<OrgRole | null> {
    const row = await queryOne<{ role: OrgRole }>(
      `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    return row?.role ?? null;
  }

  async isMember(organizationId: string, userId: string): Promise<boolean> {
    return (await this.getRole(organizationId, userId)) !== null;
  }

  async addMember(input: {
    organizationId: string;
    userId: string;
    role: OrgRole;
    invitedBy?: string | null;
  }): Promise<MembershipRecord> {
    const row = await queryOne<MembershipRecord>(
      `INSERT INTO organization_members (organization_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()
       RETURNING *`,
      [input.organizationId, input.userId, input.role, input.invitedBy ?? null],
    );
    return row!;
  }

  async updateMemberRole(organizationId: string, userId: string, role: OrgRole): Promise<void> {
    await query(
      `UPDATE organization_members SET role = $3, updated_at = now()
        WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId, role],
    );
  }

  async removeMember(organizationId: string, userId: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [organizationId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listMembers(organizationId: string): Promise<Row[]> {
    const result = await query(
      `SELECT m.user_id, m.role, m.created_at, u.email, u.display_name, u.avatar_url
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY m.created_at ASC`,
      [organizationId],
    );
    return result.rows;
  }

  async countOwners(organizationId: string): Promise<number> {
    const row = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM organization_members
        WHERE organization_id = $1 AND role = 'owner'`,
      [organizationId],
    );
    return Number(row?.count ?? 0);
  }

  async update(id: string, fields: { name?: string }): Promise<OrganizationRecord | null> {
    if (fields.name === undefined) return this.findById(id);
    return queryOne<OrganizationRecord>(
      'UPDATE organizations SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, fields.name],
    );
  }

  async softDelete(id: string): Promise<void> {
    await query(
      `UPDATE organizations SET deleted_at = now(), slug = CONCAT(slug, '-deleted-', substring(id::text, 1, 8)), updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  /* ------------------------------- invitations ------------------------------ */

  async createInvitation(input: {
    organizationId: string;
    email: string;
    role: OrgRole;
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<void> {
    await query(
      `INSERT INTO organization_invitations
         (organization_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, email) DO UPDATE
         SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash,
             expires_at = EXCLUDED.expires_at, accepted_at = NULL, invited_by = EXCLUDED.invited_by`,
      [
        input.organizationId,
        input.email,
        input.role,
        input.tokenHash,
        input.invitedBy,
        input.expiresAt,
      ],
    );
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<Row | null> {
    return queryOne<Row>(
      `SELECT * FROM organization_invitations
        WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
  }

  async acceptInvitation(id: string): Promise<void> {
    await query('UPDATE organization_invitations SET accepted_at = now() WHERE id = $1', [id]);
  }

  async listInvitations(organizationId: string): Promise<Row[]> {
    const result = await query(
      `SELECT id, email, role, expires_at, created_at FROM organization_invitations
        WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [organizationId],
    );
    return result.rows;
  }

  async deleteInvitation(organizationId: string, invitationId: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM organization_invitations WHERE organization_id = $1 AND id = $2',
      [organizationId, invitationId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
