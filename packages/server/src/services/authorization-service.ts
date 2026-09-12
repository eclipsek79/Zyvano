/**
 * Authorization service.
 *
 * Authorization is deliberately separate from authentication. Every protected
 * operation resolves the caller's effective role for the resource's scope and
 * compares it against the permission the operation requires.
 *
 * The rules implemented here are:
 *   1. the caller must be authenticated (enforced by middleware),
 *   2. the resource must belong to an organization the caller is a member of,
 *   3. the caller's role must grant the required permission,
 *   4. project-scoped access additionally honours explicit project membership.
 *
 * A resource that does not exist and a resource the caller cannot see both
 * produce NOT_FOUND, so probing ids cannot be used to enumerate other tenants.
 */
import {
  ROLE_PERMISSIONS,
  ROLE_RANK,
  errors,
  type OrgRole,
  type Permission,
} from '@zyvano/shared';

import type { OrganizationRepository } from '../repositories/organization-repository';
import type { ProjectRepository } from '../repositories/project-repository';
import type { UserRepository } from '../repositories/user-repository';

/** The authenticated principal attached to each request. */
export interface Principal {
  userId: string;
  email: string;
  sessionId: string;
  /** Organization selected for this request (usually via header or resource). */
  organizationId: string | null;
  role: OrgRole | null;
}

/** An authorization decision plus the context that produced it. */
export interface AccessDecision {
  role: OrgRole;
  organizationId: string;
  permissions: readonly Permission[];
}

export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function roleAtLeast(role: OrgRole, minimum: OrgRole): boolean {
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minimum] ?? 0);
}

export class AuthorizationService {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly projects: ProjectRepository,
    private readonly users: UserRepository,
  ) {}

  /**
   * Requires the caller to hold `permission` in the given organization.
   * Throws FORBIDDEN / NOT_FOUND rather than returning a boolean so callers
   * cannot accidentally ignore the result.
   */
  async requireOrganizationPermission(
    organizationId: string,
    userId: string,
    permission: Permission,
  ): Promise<AccessDecision> {
    const role = await this.organizations.getRole(organizationId, userId);
    if (!role) {
      // Do not reveal whether the organization exists to a non-member.
      throw errors.notFound('Organization');
    }
    if (!roleHasPermission(role, permission)) {
      throw errors.forbidden(
        `Your role (${role}) does not include the "${permission}" permission.`,
      );
    }
    return { role, organizationId, permissions: ROLE_PERMISSIONS[role] };
  }

  /**
   * Resolves the resource's organization through the project, then applies the
   * same permission check. This is the guard used by every project-scoped route
   * and is what prevents IDOR across organizations and projects.
   */
  async requireProjectPermission(
    projectId: string,
    userId: string,
    permission: Permission,
  ): Promise<AccessDecision> {
    const project = await this.projects.findById(projectId);
    if (!project) throw errors.notFound('Project');

    const role = await this.organizations.getRole(project.organization_id, userId);
    if (!role) {
      // The caller is authenticated but has no business here.
      throw errors.notFound('Project');
    }

    // Explicit project membership can elevate a viewer for that project only.
    const projectRole = await this.projects.getMemberRole(projectId, userId);
    const effectiveRole =
      projectRole && (ROLE_RANK[projectRole] ?? 0) > (ROLE_RANK[role] ?? 0) ? projectRole : role;

    if (!roleHasPermission(effectiveRole, permission)) {
      throw errors.forbidden(
        `Your role (${effectiveRole}) does not include the "${permission}" permission.`,
      );
    }
    return { role: effectiveRole, organizationId: project.organization_id, permissions: ROLE_PERMISSIONS[effectiveRole] };
  }

  /** Non-throwing variant used where the caller only needs a yes/no. */
  async canAccessProject(projectId: string, userId: string): Promise<boolean> {
    try {
      await this.requireProjectPermission(projectId, userId, 'project:read');
      return true;
    } catch {
      return false;
    }
  }

  /** The organizations a user may act within, used to resolve the active org. */
  async listAccessibleOrganizations(userId: string) {
    return this.organizations.listForUser(userId);
  }

  /**
   * Confirms the user still exists and is active. Called after session lookup so
   * a suspended or deleted account cannot keep using a live session cookie.
   */
  async assertUserActive(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.status !== 'active') throw errors.unauthenticated('Account is not active.');
  }
}
