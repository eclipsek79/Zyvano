/** Usage metering and quota enforcement. */
import { errors, type AICapability, type UsageSummaryDTO } from '@zyvano/shared';

import type { AppConfig } from '../config/env';
import type { OrganizationRepository } from '../repositories/organization-repository';
import type { UsageRepository } from '../repositories/usage-repository';

export class UsageService {
  constructor(
    private readonly usage: UsageRepository,
    private readonly organizations: OrganizationRepository,
    private readonly config: AppConfig,
  ) {}

  /**
   * Reserves credits before a provider call. Throws QUOTA_EXCEEDED when the
   * organization has no budget left, which is what stops runaway spend.
   */
  async reserve(input: { organizationId: string; credits: number }): Promise<void> {
    const granted = await this.creditsGrantedFor(input.organizationId);
    const ok = await this.usage.tryConsumeCredits(input.organizationId, granted, input.credits);
    if (!ok) {
      throw errors.quotaExceeded(
        'This workspace has no remaining generation credits for the current period.',
      );
    }
  }

  /** Records the metered usage for an actual provider call. */
  async record(input: {
    organizationId: string;
    userId?: string | null;
    projectId?: string | null;
    generationId?: string | null;
    capability: AICapability;
    provider: string;
    model?: string | null;
    units: number;
    credits: number;
  }): Promise<void> {
    await this.usage.record(input);
  }

  /** Returns reserved credits when a job fails before using the provider. */
  async release(input: { organizationId: string; credits: number }): Promise<void> {
    await this.usage.releaseCredits(input.organizationId, input.credits);
  }

  /**
   * Settles a reservation against the amount the provider actually billed.
   *
   * `reserve` withholds a conservative upper bound before dispatch so a run cannot
   * overrun the workspace budget. The real cost is only known once the provider
   * answers, so the difference is returned to the ledger here. Without this a
   * workspace would permanently lose the difference between the reservation and the
   * metered cost, and the usage summary would disagree with the provider's billing.
   */
  async reconcile(input: {
    organizationId: string;
    reserved: number;
    actual: number;
  }): Promise<void> {
    // Signed: the actual cost replaces the reservation, so a cheaper-than-reserved
    // run refunds the difference and a more expensive one charges the shortfall.
    const delta = input.actual - input.reserved;
    if (delta === 0) return;
    await this.usage.adjustCredits(input.organizationId, delta);
  }

  async summary(input: { organizationId: string; days: number }): Promise<UsageSummaryDTO> {
    const granted = await this.creditsGrantedFor(input.organizationId);
    return this.usage.summary({ organizationId: input.organizationId, days: input.days, creditsGranted: granted });
  }

  async recent(organizationId: string, limit = 50) {
    return this.usage.listRecent(organizationId, limit);
  }

  /**
   * Organizations may carry an explicit credit grant in their settings; otherwise
   * they receive the configured free-tier allowance on their first period.
   */
  private async creditsGrantedFor(organizationId: string): Promise<number> {
    const organization = await this.organizations.findById(organizationId);
    const settings = (organization?.settings ?? {}) as { creditsGranted?: number };
    if (typeof settings.creditsGranted === 'number' && settings.creditsGranted > 0) {
      return settings.creditsGranted;
    }
    return this.config.limits.freeTierCredits;
  }
}
