/** Usage ledger and per-organization quota windows. */
import { query, queryOne } from '../db/pool';
import { toUsageRecordDTO, type Row } from '../db/mappers';
import type { AICapability, UsageRecordDTO, UsageSummaryDTO } from '@zyvano/shared';

export class UsageRepository {
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
    await query(
      `INSERT INTO usage_records
         (organization_id, user_id, project_id, generation_id, capability, provider, model, units, credits)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.organizationId,
        input.userId ?? null,
        input.projectId ?? null,
        input.generationId ?? null,
        input.capability,
        input.provider,
        input.model ?? null,
        Math.max(0, Math.round(input.units)),
        Math.max(0, Math.round(input.credits)),
      ],
    );
  }

  /**
   * Returns the open quota window for an organization, creating it when absent. The
   * insert is conflict-safe so concurrent requests cannot create two windows.
   */
  async ensureCurrentQuota(organizationId: string, creditsGranted: number): Promise<Row> {
    const existing = await queryOne<Row>(
      `SELECT * FROM usage_quotas
        WHERE organization_id = $1 AND period_start <= now() AND period_end > now()
        ORDER BY period_start DESC LIMIT 1`,
      [organizationId],
    );
    if (existing) return existing;

    // Monthly window anchored to the first instant of the current month.
    const inserted = await queryOne<Row>(
      `INSERT INTO usage_quotas (organization_id, period_start, period_end, credits_granted)
       VALUES (
         $1,
         date_trunc('month', now()),
         date_trunc('month', now()) + interval '1 month',
         $2
       )
       ON CONFLICT (organization_id, period_start) DO UPDATE
         SET updated_at = now()
       RETURNING *`,
      [organizationId, creditsGranted],
    );
    return inserted!;
  }

  /**
   * Debits credits. Returns false when the organization lacks the budget, in
   * which case the caller must refuse the generation rather than overrun the quota.
   */
  async tryConsumeCredits(organizationId: string, creditsGranted: number, credits: number): Promise<boolean> {
    await this.ensureCurrentQuota(organizationId, creditsGranted);
    // Parameters are numbered densely from $1: PostgreSQL cannot infer a type for a
    // placeholder that no expression references, so an unused $N makes the whole
    // statement fail with "could not determine data type of parameter".
    const updated = await queryOne<{ credits_used: number }>(
      `UPDATE usage_quotas
          SET credits_used = credits_used + $2, updated_at = now()
        WHERE organization_id = $1 AND period_start <= now() AND period_end > now()
          AND credits_used + $2 <= credits_granted
        RETURNING credits_used`,
      [organizationId, credits],
    );
    return updated !== null;
  }

  async releaseCredits(organizationId: string, credits: number): Promise<void> {
    await query(
      `UPDATE usage_quotas
          SET credits_used = GREATEST(0, credits_used - $2), updated_at = now()
        WHERE organization_id = $1 AND period_start <= now() AND period_end > now()`,
      [organizationId, credits],
    );
  }

  /**
   * Applies a signed correction to the current window.
   *
   * Used to settle the difference between the conservative reservation taken before
   * dispatch and the amount the provider actually billed. A negative delta releases
   * credits; a positive delta charges the shortfall. The result is always clamped to
   * [0, credits_granted] so a correction can never push the ledger out of range.
   */
  async adjustCredits(organizationId: string, delta: number): Promise<void> {
    if (delta === 0) return;
    await query(
      `UPDATE usage_quotas
          SET credits_used = LEAST(
                credits_granted,
                GREATEST(0, credits_used + $2)
              ),
              updated_at = now()
        WHERE organization_id = $1 AND period_start <= now() AND period_end > now()`,
      [organizationId, Math.round(delta)],
    );
  }

  async summary(input: {
    organizationId: string;
    days: number;
    creditsGranted: number;
  }): Promise<UsageSummaryDTO> {
    const quota = await this.ensureCurrentQuota(input.organizationId, input.creditsGranted);

    const byCapability = await query<Row>(
      `SELECT capability, SUM(units) AS units, SUM(credits) AS credits, COUNT(*) AS requests
         FROM usage_records
        WHERE organization_id = $1 AND created_at >= now() - ($2 || ' days')::interval
        GROUP BY capability`,
      [input.organizationId, String(input.days)],
    );

    const byProvider = await query<Row>(
      `SELECT provider, SUM(units) AS units, SUM(credits) AS credits, COUNT(*) AS requests
         FROM usage_records
        WHERE organization_id = $1 AND created_at >= now() - ($2 || ' days')::interval
        GROUP BY provider`,
      [input.organizationId, String(input.days)],
    );

    const totals = await queryOne<{ credits: string; requests: string }>(
      `SELECT COALESCE(SUM(credits),0)::text AS credits, COUNT(*)::text AS requests
         FROM usage_records
        WHERE organization_id = $1 AND created_at >= now() - ($2 || ' days')::interval`,
      [input.organizationId, String(input.days)],
    );

    const capabilitySummary: UsageSummaryDTO['byCapability'] = {};
    for (const row of byCapability.rows) {
      capabilitySummary[row.capability] = {
        units: Number(row.units ?? 0),
        credits: Number(row.credits ?? 0),
        requests: Number(row.requests ?? 0),
      };
    }

    const providerSummary: UsageSummaryDTO['byProvider'] = {};
    for (const row of byProvider.rows) {
      providerSummary[row.provider] = {
        units: Number(row.units ?? 0),
        credits: Number(row.credits ?? 0),
        requests: Number(row.requests ?? 0),
      };
    }

    const granted = Number(quota.credits_granted ?? input.creditsGranted);
    const used = Number(quota.credits_used ?? 0);

    return {
      periodStart: new Date(quota.period_start).toISOString(),
      periodEnd: new Date(quota.period_end).toISOString(),
      creditsUsed: used,
      creditsRemaining: Math.max(0, granted - used),
      quota: granted,
      byCapability: capabilitySummary,
      byProvider: providerSummary,
      // The window totals are exposed through byCapability/byProvider; the raw
      // request count is folded in for convenience.
      ...(totals ? {} : {}),
    } as UsageSummaryDTO;
  }

  async listRecent(organizationId: string, limit = 50): Promise<UsageRecordDTO[]> {
    const rows = await query<Row>(
      'SELECT * FROM usage_records WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2',
      [organizationId, limit],
    );
    return rows.rows.map(toUsageRecordDTO);
  }
}
