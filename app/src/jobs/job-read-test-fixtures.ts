import type { JobEconomics, JobEconomicsReadView } from "./job-economics-read-view";

export function economicsFixture(): JobEconomics {
  const unknown = { known_cents: null, complete: false, source_count: 0 };
  return {
    tenant_id: "freshco",
    job_id: "JOB-READ-001",
    currency: "CAD",
    state: "incomplete",
    metrics: {
      forecast_revenue: { known_cents: 200_010, complete: false, source_count: 1 },
      forecast_cost: { ...unknown },
      committed_cost: { known_cents: 150_005, complete: true, source_count: 2 },
      accrued_actual_cost: { ...unknown },
      posted_actual_cost: { known_cents: 0, complete: true, source_count: 1 },
      invoiced_revenue_ex_tax: { ...unknown },
      cash_collected: { ...unknown },
      actual_profit: {
        amount_cents: null,
        state: "unavailable",
        reason: "posted_revenue_recognition_unavailable",
      },
    },
    source_coverage: {
      customer_quotes: 1,
      accepted_change_orders: 0,
      supplier_quotes: 0,
      committed_supplier_orders: 2,
      material_lots: 3,
      progressed_shop_orders: 0,
      verified_field_checkins: 0,
      matched_payment_milestones: 0,
      posted_revenue_milestones: 0,
      cost_events: 1,
      valid_reversals: 0,
      posted_cost_events: 1,
      matched_cost_reconciliations: 1,
    },
    reconciliation_gaps: ["customer_quotes_partial"],
  };
}

export function moneyReadFixture(): JobEconomicsReadView {
  return {
    economics: economicsFixture(),
    read_model_generated_at: "2026-10-02T10:01:00.000Z",
    source_updated_at: "2026-10-02T10:00:00.000Z",
    partial_sources: ["customer_quotes"],
    stale_fields: [],
  };
}
