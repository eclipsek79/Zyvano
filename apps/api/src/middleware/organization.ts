/**
 * Organization scoping.
 *
 * Resolves which organization a request operates in and proves the caller is a
 * member of it. An explicit identifier (header or query) is honoured only after
 * membership is verified, so a forged header cannot reach another tenant.
 */
import type { Request } from 'express';

import { errors } from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';

const ORG_HEADER = 'x-zyvano-organization';

/**
 * Resolves the active organization id for the request.
 *
 * Order: explicit header, explicit query parameter, then the caller's oldest
 * membership. Throws FORBIDDEN when an explicit id is supplied but the caller is
 * not a member (never NOT_FOUND, so the response does not confirm the id exists).
 */
export async function resolveOrganizationId(
  container: Container,
  req: Request,
  explicit?: string | undefined,
): Promise<string> {
  const auth = req.auth;
  if (!auth) throw errors.unauthenticated();

  const requested =
    explicit ?? (req.header(ORG_HEADER) || undefined) ?? ((req.query.organizationId as string | undefined) || undefined);

  if (requested) {
    const role = await container.repositories.organizations.getRole(requested, auth.user.id);
    if (!role) throw errors.forbidden('You are not a member of this workspace.');
    auth.organizationId = requested;
    return requested;
  }

  const organizations = await container.repositories.organizations.listForUser(auth.user.id);
  const first = organizations[0];
  if (!first) {
    // Every account is given a workspace at registration; reaching this state
    // means the membership rows were removed out from under the account.
    throw errors.conflict('Your account is not a member of any workspace.');
  }
  auth.organizationId = first.id;
  return first.id;
}

/** Resolves the organization that owns a project and verifies membership. */
export async function resolveProjectOrganization(
  container: Container,
  req: Request,
  projectId: string,
): Promise<string> {
  const auth = req.auth;
  if (!auth) throw errors.unauthenticated();

  const project = await container.repositories.projects.findById(projectId);
  if (!project) throw errors.notFound('Project');

  const role = await container.repositories.organizations.getRole(
    project.organization_id as string,
    auth.user.id,
  );
  if (!role) throw errors.notFound('Project');

  auth.organizationId = project.organization_id as string;
  return project.organization_id as string;
}

export { ORG_HEADER };
