/**
 * Data lifecycle: controlled deletion.
 *
 * Deletion spans four surfaces that must stay consistent: database rows, object
 * storage, queued jobs, and the audit trail. Order matters — storage is purged
 * before rows are removed, so a crash mid-deletion leaves orphaned storage
 * (recoverable by the cleanup worker) rather than dangling database references.
 */
import { errors } from '@zyvano/shared';

import { withTransaction } from '../db/pool';
import type { ObjectStorage } from '../infrastructure/storage';
import type { AssetRepository } from '../repositories/asset-repository';
import type { AuditService } from './audit-service';
import type { ExportRepository } from '../repositories/export-repository';
import type { GenerationRepository } from '../repositories/generation-repository';
import type { JobRepository } from '../repositories/job-repository';
import type { OrganizationRepository } from '../repositories/organization-repository';
import type { ProjectRepository } from '../repositories/project-repository';
import type { DeletionRequestRepository } from '../repositories/deletion-request-repository';
import type { UserRepository } from '../repositories/user-repository';

export interface DeletionResult {
  objectsDeleted: number;
  objectsFailed: string[];
  projectsDeleted: number;
}

export class DeletionService {
  constructor(
    private readonly assets: AssetRepository,
    private readonly projects: ProjectRepository,
    private readonly generations: GenerationRepository,
    private readonly exports: ExportRepository,
    private readonly jobs: JobRepository,
    private readonly organizations: OrganizationRepository,
    private readonly users: UserRepository,
    private readonly deletionRequests: DeletionRequestRepository,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Permanently deletes a project and everything it owns.
   *
   * The project row is soft-deleted first so the project disappears from the UI
   * immediately and cannot be mutated while the purge runs; this method then
   * removes the children and the media.
   */
  async deleteProject(input: {
    projectId: string;
    organizationId: string;
    actorUserId: string;
    actorEmail: string;
  }): Promise<DeletionResult> {
    const project = await this.projects.findById(input.projectId);
    if (!project || project.organization_id !== input.organizationId) {
      throw errors.notFound('Project');
    }

    // 1. Collect every storage key before anything is removed.
    const storageKeys = await this.projects.listAssetStorageKeys(input.projectId);

    // 2. Hide the project immediately.
    await this.projects.softDelete(input.projectId);

    // 3. Purge storage. Failures are collected, not thrown: the database purge
    //    proceeds and the cleanup worker retries the leftovers.
    const { deleted, failed } = await this.storage.deleteMany(storageKeys);

    // 4. Remove database children and the project row in one transaction.
    //
    //    Ordering is driven by foreign keys, not by preference. `assets.owner_id`
    //    references `users` with ON DELETE RESTRICT, which makes the order fragile, so
    //    every reference to a user is cleared before any user row could be removed.
    //    `exports` is removed before `assets` because `export_files.asset_id` is NOT
    //    NULL: a surviving file row would either block the asset delete or silently
    //    leave an orphaned output.
    await withTransaction(async (client) => {
      await this.jobs.deleteForProject(input.projectId, client);
      await this.exports.deleteForProject(input.projectId, client);
      await this.generations.deleteForProject(input.projectId, client);
      await client.query('DELETE FROM scenes WHERE project_id = $1', [input.projectId]);
      await client.query('DELETE FROM storyboards WHERE project_id = $1', [input.projectId]);
      await client.query('DELETE FROM scripts WHERE project_id = $1', [input.projectId]);
      await client.query('DELETE FROM assets WHERE project_id = $1', [input.projectId]);
      await client.query('DELETE FROM project_members WHERE project_id = $1', [input.projectId]);
      await client.query('DELETE FROM projects WHERE id = $1', [input.projectId]);
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      category: 'destructive',
      action: 'project.deleted',
      resourceType: 'project',
      resourceId: input.projectId,
      metadata: {
        objectsDeleted: deleted,
        objectsFailed: failed.length,
        name: project.name as string,
      },
    });

    return { objectsDeleted: deleted, objectsFailed: failed, projectsDeleted: 1 };
  }

  /** Processes queued storage deletions recorded by the asset delete endpoint. */
  async processPendingAssetDeletions(limit = 100): Promise<{ processed: number; failed: number }> {
    const pending = await this.assets.listPendingDeletions(limit);
    let processed = 0;
    let failed = 0;

    for (const record of pending) {
      const keys = (record.storage_keys as string[]) ?? [];
      try {
        const result = await this.storage.deleteMany(keys);
        if (result.failed.length > 0) {
          await this.assets.recordDeletionFailure(
            record.id as string,
            `Could not delete: ${result.failed.join(', ')}`,
          );
          failed += 1;
          continue;
        }
        await this.assets.hardDelete(record.asset_id as string);
        await this.assets.completeDeletion(record.id as string);
        processed += 1;
      } catch (error) {
        await this.assets.recordDeletionFailure(
          record.id as string,
          error instanceof Error ? error.message : String(error),
        );
        failed += 1;
      }
    }

    return { processed, failed };
  }

  /**
   * Account deletion.
   *
   * Personal data is scrubbed, media is purged, and the user row is tombstoned rather
   * than hard-deleted. Tombstoning is deliberate: `audit_events` and
   * `deletion_requests` reference the actor, and a hard delete would either cascade
   * those records away or be blocked by them — destroying the evidence that the
   * deletion happened.
   *
   * Ownership is the subtlety here. An organization a user *solely owns* is torn down
   * completely. An organization they merely belong to must keep its content for the
   * remaining members, so only this user's own contributions are removed. Erasing the
   * whole workspace for a departing editor would destroy other people's work.
   */
  async deleteAccount(input: {
    userId: string;
    userEmail: string;
    organizations: Array<{ id: string; role: string }>;
  }): Promise<DeletionResult> {
    let objectsDeleted = 0;
    const objectsFailed: string[] = [];
    let projectsDeleted = 0;

    for (const organization of input.organizations) {
      if (organization.role === 'owner') {
        const owners = await this.organizations.countOwners(organization.id);
        if (owners <= 1) {
          const result = await this.purgeOrganization({
            organizationId: organization.id,
            actorUserId: input.userId,
            actorEmail: input.userEmail,
          });
          objectsDeleted += result.objectsDeleted;
          objectsFailed.push(...result.objectsFailed);
          projectsDeleted += result.projectsDeleted;
          continue;
        }
      }

      // Shared workspace: the user leaves, their personal footprint is scrubbed, and
      // everything the rest of the team depends on is left standing.
      await this.scrubMembership({
        organizationId: organization.id,
        userId: input.userId,
        actorEmail: input.userEmail,
      });
    }

    await this.audit.record({
      actorUserId: input.userId,
      actorEmail: input.userEmail,
      category: 'destructive',
      action: 'account.deleted',
      resourceType: 'user',
      resourceId: input.userId,
      metadata: { organizations: input.organizations.length, objectsDeleted },
    });

    return { objectsDeleted, objectsFailed, projectsDeleted };
  }

  /**
   * Removes a departing member's own projects and unlinks their user references, while
   * leaving the workspace and its shared content intact.
   */
  private async scrubMembership(input: {
    organizationId: string;
    userId: string;
    actorEmail: string;
  }): Promise<void> {
    const owned = await this.projects.list({
      organizationId: input.organizationId,
      ownerId: input.userId,
      page: 1,
      perPage: 1000,
    });

    for (const project of owned.items) {
      const result = await this.deleteProject({
        projectId: project.id,
        organizationId: input.organizationId,
        actorUserId: input.userId,
        actorEmail: input.actorEmail,
      });
      void result;
    }

    // References that would otherwise block the tombstone. Each is scoped to this user
    // so another member's rows are never touched.
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE audit_events SET actor_user_id = NULL WHERE actor_user_id = $1",
        [input.userId],
      );
      await client.query('DELETE FROM notifications WHERE user_id = $1', [input.userId]);
      await client.query('DELETE FROM project_members WHERE user_id = $1', [input.userId]);
      await client.query('UPDATE usage_records SET user_id = NULL WHERE user_id = $1', [
        input.userId,
      ]);
      await client.query('DELETE FROM api_keys WHERE created_by = $1', [input.userId]);
      await client.query('DELETE FROM organization_invitations WHERE invited_by = $1', [
        input.userId,
      ]);
    });

    await this.organizations.removeMember(input.organizationId, input.userId);
  }

  /**
   * Purges an organization the user solely owns, including every stored object it
   * references.
   *
   * Storage is emptied from the database's own record of keys rather than from a
   * directory listing: every key that has a row is collected and removed, and the
   * returned count is the number of objects actually deleted. Reporting a deletion that
   * did not happen would be worse than reporting a failure.
   */
  private async purgeOrganization(input: {
    organizationId: string;
    actorUserId: string;
    actorEmail: string;
  }): Promise<DeletionResult> {
    const projectRows = await this.projects.list({
      organizationId: input.organizationId,
      page: 1,
      perPage: 1000,
    });

    let objectsDeleted = 0;
    const objectsFailed: string[] = [];
    let projectsDeleted = 0;

    for (const project of projectRows.items) {
      const result = await this.deleteProject({
        projectId: project.id,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
      });
      objectsDeleted += result.objectsDeleted;
      objectsFailed.push(...result.objectsFailed);
      projectsDeleted += result.projectsDeleted;
    }

    // Assets owned directly by the organization (not attached to a project) still hold
    // bytes in storage. Their keys are collected *before* the rows are removed, because
    // afterwards there is nothing left to tell us what to purge.
    const orphanKeys = await this.assets.listStorageKeysForOrganization(input.organizationId);
    if (orphanKeys.length > 0) {
      const { deleted, failed } = await this.storage.deleteMany(orphanKeys);
      objectsDeleted += deleted;
      objectsFailed.push(...failed);
    }

    // Rows are removed only after the purge attempt, and the storage failures are
    // returned so the caller can retry rather than being told everything succeeded.
    await this.assets.hardDeleteAllForOrganization(input.organizationId);

    await withTransaction(async (client) => {
      await client.query(
        'UPDATE audit_events SET actor_user_id = NULL WHERE actor_user_id = $1',
        [input.actorUserId],
      );
      await client.query('DELETE FROM notifications WHERE organization_id = $1', [
        input.organizationId,
      ]);
      await client.query('DELETE FROM usage_records WHERE organization_id = $1', [
        input.organizationId,
      ]);
      await client.query('DELETE FROM usage_quotas WHERE organization_id = $1', [
        input.organizationId,
      ]);
      await client.query('DELETE FROM organization_invitations WHERE organization_id = $1', [
        input.organizationId,
      ]);
      await client.query('DELETE FROM api_keys WHERE organization_id = $1', [
        input.organizationId,
      ]);
      await client.query('DELETE FROM organization_members WHERE organization_id = $1', [
        input.organizationId,
      ]);
    });

    await this.organizations.softDelete(input.organizationId);

    return { objectsDeleted, objectsFailed, projectsDeleted };
  }

  /**
   * Tombstones the account itself and clears its security state.
   *
   * Runs last, after every foreign key that points at the user has been cleared or
   * cascaded, so it cannot fail on a constraint. `users.softDelete` scrubs the address
   * and the password hash and marks the row `deleted`, which is what makes the stored
   * credentials unusable even before the rows are removed.
   */
  async tombstoneAccount(userId: string): Promise<void> {
    await this.deletionRequests.purgeUserNativeRows(userId);
    await this.users.softDelete(userId);
  }

  /** Removes storage objects left behind by failed deletions (orphan sweep). */
  async sweepExpiredExports(limit = 50): Promise<{ purged: number }> {
    const expired = await this.exports.findExpired(limit);
    let purged = 0;
    for (const exportRow of expired) {
      const files = await this.exports.listFiles(exportRow.id as string);
      const keys = files.map((file) => file.storage_key as string);
      const { failed } = await this.storage.deleteMany(keys);
      if (failed.length === 0) {
        await this.exports.deleteCascade(exportRow.id as string);
        purged += 1;
      }
    }
    return { purged };
  }
}
