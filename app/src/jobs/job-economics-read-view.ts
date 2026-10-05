import { z } from "zod";

import { ApiError, apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";

const metricSchema = z
  .object({
    known_cents: z.number().int().safe().nullable(),
    complete: z.boolean(),
    source_count: z.number().int().nonnegative(),
  })
  .strict();

/** Matches the existing Worker JobEconomicsProjection. A known sum is not a complete total. */
export const jobEconomicsSchema = z
  .object({
    tenant_id: z.string().min(1),
    job_id: z.string().min(1),
    currency: z.string().nullable(),
    state: z.enum(["complete", "needs_review", "incomplete"]),
    metrics: z
      .object({
        forecast_revenue: metricSchema,
        forecast_cost: metricSchema,
        committed_cost: metricSchema,
        accrued_actual_cost: metricSchema,
        posted_actual_cost: metricSchema,
        invoiced_revenue_ex_tax: metricSchema,
        cash_collected: metricSchema,
        actual_profit: z
          .object({
            amount_cents: z.null(),
            state: z.literal("unavailable"),
            reason: z.literal("posted_revenue_recognition_unavailable"),
          })
          .strict(),
      })
      .strict(),
    source_coverage: z
      .object({
        customer_quotes: z.number().int().nonnegative(),
        accepted_change_orders: z.number().int().nonnegative(),
        supplier_quotes: z.number().int().nonnegative(),
        committed_supplier_orders: z.number().int().nonnegative(),
        material_lots: z.number().int().nonnegative(),
        progressed_shop_orders: z.number().int().nonnegative(),
        verified_field_checkins: z.number().int().nonnegative(),
        matched_payment_milestones: z.number().int().nonnegative(),
        posted_revenue_milestones: z.number().int().nonnegative(),
        cost_events: z.number().int().nonnegative(),
        valid_reversals: z.number().int().nonnegative(),
        posted_cost_events: z.number().int().nonnegative(),
        matched_cost_reconciliations: z.number().int().nonnegative(),
      })
      .strict(),
    reconciliation_gaps: z.array(z.string()),
  })
  .strict();

export type JobEconomics = z.infer<typeof jobEconomicsSchema>;

const jobEconomicsReadSchema = z.object({
  job: z.object({ id: z.string().min(1) }),
  economics: jobEconomicsSchema,
  read_model_generated_at: z.string().min(1),
  source_updated_at: z.string().nullable(),
  stale_fields: z.array(z.string()),
  partial_sources: z.array(z.string()),
});

export type JobEconomicsReadView = Pick<
  z.infer<typeof jobEconomicsReadSchema>,
  "economics" | "read_model_generated_at" | "source_updated_at" | "stale_fields" | "partial_sources"
>;

/** Reads a bounded view of the existing estimator endpoint, without exposing its write actions. */
export async function loadJobEconomics(
  tenantId: string,
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<JobEconomicsReadView | null> {
  try {
    const model = await apiRequest({
      path: API_PATHS.estimatorJob(jobId),
      schema: jobEconomicsReadSchema,
      fetcher,
    });
    if (
      model.job.id !== jobId ||
      model.economics.job_id !== jobId ||
      model.economics.tenant_id !== tenantId
    ) {
      throw new Error("The money record does not match this job.");
    }
    const { economics, read_model_generated_at, source_updated_at, stale_fields, partial_sources } =
      model;
    return { economics, read_model_generated_at, source_updated_at, stale_fields, partial_sources };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}
