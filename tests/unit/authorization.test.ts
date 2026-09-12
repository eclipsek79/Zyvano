/**
 * Authorization logic.
 *
 * These tests pin the privilege matrix itself. A change that quietly widens a
 * role's grants — the classic path to an escalation bug — fails here before it
 * can reach a route.
 */
import { describe, expect, it } from 'vitest';

import { ORG_ROLES, PERMISSIONS, ROLE_PERMISSIONS, type OrgRole, type Permission } from '@zyvano/shared';
import { roleAtLeast, roleHasPermission } from '@zyvano/server/services/authorization-service';

const SENSITIVE: readonly Permission[] = [
  'org:delete',
  'org:manage_members',
  'project:delete',
  'generation:create',
  'export:create',
  'audit:read',
];

describe('roleHasPermission', () => {
  it('grants an owner every declared permission', () => {
    for (const permission of PERMISSIONS) {
      expect(roleHasPermission('owner', permission)).toBe(true);
    }
  });

  it('denies a viewer every mutating permission', () => {
    const mutating: Permission[] = [
      'project:create',
      'project:update',
      'project:delete',
      'asset:upload',
      'asset:delete',
      'generation:create',
      'export:create',
      'org:manage_members',
      'org:update',
      'org:delete',
      'template:manage',
      'apikey:manage',
    ];

    for (const permission of mutating) {
      expect(roleHasPermission('viewer', permission)).toBe(false);
    }
  });

  it('lets a viewer still read what it is given access to', () => {
    expect(roleHasPermission('viewer', 'project:read')).toBe(true);
    expect(roleHasPermission('viewer', 'asset:read')).toBe(true);
    expect(roleHasPermission('viewer', 'export:read')).toBe(true);
  });

  it('keeps destructive organization actions with the owner only', () => {
    expect(roleHasPermission('owner', 'org:delete')).toBe(true);
    expect(roleHasPermission('admin', 'org:delete')).toBe(false);
    for (const role of ['editor', 'member', 'viewer'] as const) {
      expect(roleHasPermission(role, 'org:delete')).toBe(false);
    }
  });

  it('keeps member administration out of editor and below', () => {
    expect(roleHasPermission('admin', 'org:manage_members')).toBe(true);
    for (const role of ['editor', 'member', 'viewer'] as const) {
      expect(roleHasPermission(role, 'org:manage_members')).toBe(false);
    }
  });

  it('never grants an unknown role anything', () => {
    expect(roleHasPermission('superuser' as OrgRole, 'project:read')).toBe(false);
    // A role value arriving from a forged token or a corrupted row grants nothing.
    expect(roleHasPermission('' as OrgRole, 'org:read')).toBe(false);
  });

  it('gives editors generation but not member management', () => {
    expect(roleHasPermission('editor', 'generation:create')).toBe(true);
    expect(roleHasPermission('editor', 'export:create')).toBe(true);
    expect(roleHasPermission('editor', 'org:manage_members')).toBe(false);
    expect(roleHasPermission('editor', 'audit:read')).toBe(false);
  });

  it('records every sensitive permission as denied for at least one role', () => {
    // If a permission were granted to all five roles it would not be a control.
    for (const permission of SENSITIVE) {
      const holders = ORG_ROLES.filter((role) => roleHasPermission(role, permission));
      expect(holders.length).toBeLessThan(ORG_ROLES.length);
    }
  });
});

describe('ROLE_PERMISSIONS table integrity', () => {
  it('declares grants only for known roles and known permissions', () => {
    const knownPermissions = new Set<string>(PERMISSIONS);

    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      expect(ORG_ROLES).toContain(role as OrgRole);
      for (const grant of grants) {
        expect(knownPermissions.has(grant)).toBe(true);
      }
    }
  });

  it('grants a subset of the owner set to every other role', () => {
    const ownerGrants = new Set<Permission>(ROLE_PERMISSIONS.owner);

    for (const role of ORG_ROLES.filter((r) => r !== 'owner')) {
      for (const grant of ROLE_PERMISSIONS[role]) {
        expect(ownerGrants.has(grant)).toBe(true);
      }
    }
  });

  it('never lets a lower role hold a permission its superior lacks', () => {
    // admin ⊇ editor ⊇ member ⊇ viewer. A violation means the hierarchy is not
    // a hierarchy, and `roleAtLeast` checks would be misleading.
    const chain: OrgRole[] = ['owner', 'admin', 'editor', 'member', 'viewer'];

    for (let index = 0; index < chain.length - 1; index += 1) {
      const higher = new Set<Permission>(ROLE_PERMISSIONS[chain[index]!]);
      for (const grant of ROLE_PERMISSIONS[chain[index + 1]!]) {
        expect(higher.has(grant)).toBe(true);
      }
    }
  });
});

describe('roleAtLeast', () => {
  it('ranks roles correctly', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
    expect(roleAtLeast('editor', 'member')).toBe(true);
    expect(roleAtLeast('viewer', 'member')).toBe(false);
  });
});
