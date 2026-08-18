import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildJobEconomicsProjection,
  currencyAmountToCents,
  type EconomicsRow,
  type JobEconomicsInput,
} from "../src/job-economics.ts";

const SHA = "a".repeat(64);

function cost(overrides: EconomicsRow = {}): EconomicsRow {
  return {
    name: "cost:1",
    job_cost_event_id: "cost:1",
    tenant: "ironwrap",
    roof_job: "JOB-1",
    event_kind: "cost",
    category: "Material",
    quantity: 1,
    unit: "each",
    amount_cents: 12_345,
    amount_basis: "Net of Recoverable Tax",
    currency: "CAD",
    occurred_at: "2026-08-12T10:00:00Z",
    source_doctype: "Material Lot",
    source_name: "LOT-1",
    source_digest: SHA,
    source_evidence: "EVID-1",
    accounting_state: "Operational",
    recorded_at: "2026-08-12T12:10:00Z",
    ...overrides,
  };
}

function input(overrides: Partial<JobEconomicsInput> = {}): JobEconomicsInput {
  return {
    tenantId: "ironwrap",
    jobId: "JOB-1",
    customerQuotes: [
      {
        name: "QUOTE-1",
        roof_job: "JOB-1",
        quote_version: 1,
        status: "Accepted",
        subtotal: "1000.00",
        tax_amount: "50.00",
        quote_total: "1050.00",
        currency: "CAD",
      },
    ],
    changeOrders: [],
    supplierQuotes: [
      {
        name: "SQ-1",
        roof_job: "JOB-1",
        status: "Approved",
        quote_total: "400.00",
        currency: "CAD",
      },
    ],
    supplierOrders: [
      {
        name: "SO-1",
        roof_job: "JOB-1",
        status: "Ordered",
        source_quote: "SQ-1",
      },
    ],
    materialLots: [
      { name: "LOT-1", roof_job: "JOB-1", status: "Available" },
    ],
    shopOrders: [],
    fieldCheckins: [],
    paymentMilestones: [],
    costEvents: [cost()],
    accountingReconciliations: [],
    ...overrides,
  };
}

test("currency decimals use exact cents and reject implicit rounding", () => {
  assert.equal(currencyAmountToCents("12.34"), 1234);
  assert.equal(currencyAmountToCents("0.1"), 10);
  assert.equal(currencyAmountToCents("-1.05"), -105);
  assert.equal(currencyAmountToCents("1.005"), null);
  assert.equal(currencyAmountToCents(Number.POSITIVE_INFINITY), null);
});

test("forecast, commitments, accrual, invoices, tax, and cash stay separate", () => {
  const projection = buildJobEconomicsProjection(
    input({
      changeOrders: [
        {
          name: "CO-1",
          roof_job: "JOB-1",
          status: "Accepted",
          subtotal: "100.00",
          tax_amount: "5.00",
          total_amount: "105.00",
          currency: "CAD",
        },
      ],
      paymentMilestones: [
        {
          name: "INV-1",
          roof_job: "JOB-1",
          status: "Matched",
          milestone_type: "Invoice",
          subtotal: "1100.00",
          tax_amount: "55.00",
          total_amount: "1155.00",
          currency: "CAD",
        },
        {
          name: "PAY-1",
          roof_job: "JOB-1",
          status: "Matched",
          milestone_type: "Payment",
          total_amount: "500.00",
          currency: "CAD",
        },
      ],
    }),
  );
  assert.equal(projection.metrics.forecast_revenue.known_cents, 110_000);
  assert.equal(projection.metrics.forecast_cost.known_cents, 40_000);
  assert.equal(projection.metrics.forecast_cost.complete, false);
  assert.equal(projection.metrics.committed_cost.known_cents, 40_000);
  assert.equal(projection.metrics.committed_cost.complete, false);
  assert.equal(projection.metrics.accrued_actual_cost.known_cents, 12_345);
  assert.equal(projection.metrics.posted_actual_cost.known_cents, 0);
  assert.equal(projection.metrics.invoiced_revenue_ex_tax.known_cents, 110_000);
  assert.equal(projection.metrics.cash_collected.known_cents, 50_000);
  assert.equal(projection.metrics.actual_profit.amount_cents, null);
  assert.ok(
    projection.reconciliation_gaps.includes(
      "supplier_quote.tax_basis_unverified:SQ-1",
    ),
  );
});

test("positive reversal arithmetic is deterministic and corrected costs are new facts", () => {
  const original = cost();
  const reversal = cost({
    name: "reversal:1",
    job_cost_event_id: "reversal:1",
    event_kind: "reversal",
    reversal_of: "cost:1",
  });
  const corrected = cost({
    name: "cost:2",
    job_cost_event_id: "cost:2",
    amount_cents: 10_000,
    source_name: "LOT-2",
    source_digest: "b".repeat(64),
    source_evidence: "EVID-2",
  });
  const projection = buildJobEconomicsProjection(
    input({
      materialLots: [
        { name: "LOT-2", roof_job: "JOB-1", status: "Available" },
      ],
      costEvents: [original, reversal, corrected],
    }),
  );
  assert.equal(projection.metrics.accrued_actual_cost.known_cents, 10_000);
  assert.equal(projection.source_coverage.valid_reversals, 1);
  assert.ok(!projection.reconciliation_gaps.some((gap) => gap.includes("reversal:")));
});

test("dangling, mismatched, and double reversals fail closed", () => {
  const projection = buildJobEconomicsProjection(
    input({
      costEvents: [
        cost(),
        cost({
          name: "reversal:1",
          job_cost_event_id: "reversal:1",
          event_kind: "reversal",
          reversal_of: "cost:1",
        }),
        cost({
          name: "reversal:2",
          job_cost_event_id: "reversal:2",
          event_kind: "reversal",
          reversal_of: "cost:1",
        }),
        cost({
          name: "reversal:3",
          job_cost_event_id: "reversal:3",
          event_kind: "reversal",
          reversal_of: "missing",
        }),
        cost({
          name: "reversal:4",
          job_cost_event_id: "reversal:4",
          event_kind: "reversal",
          reversal_of: "cost:1",
          currency: "USD",
        }),
      ],
    }),
  );
  assert.equal(projection.metrics.accrued_actual_cost.known_cents, 12_345);
  assert.equal(projection.metrics.accrued_actual_cost.complete, false);
  assert.ok(projection.reconciliation_gaps.includes("job_cost_event.double_reversal:reversal:1"));
  assert.ok(projection.reconciliation_gaps.includes("job_cost_event.double_reversal:reversal:2"));
  assert.ok(projection.reconciliation_gaps.includes("job_cost_event.dangling_reversal:reversal:3"));
  assert.ok(projection.reconciliation_gaps.includes("job_cost_event.double_reversal:reversal:4"));
});

test("duplicate event ids never double count and make actual-cost coverage incomplete", () => {
  const projection = buildJobEconomicsProjection(
    input({ costEvents: [cost(), cost()] }),
  );
  assert.equal(projection.metrics.accrued_actual_cost.known_cents, 12_345);
  assert.equal(projection.metrics.accrued_actual_cost.complete, false);
  assert.ok(
    projection.reconciliation_gaps.includes("job_cost_event.duplicate_id:cost:1"),
  );
});

test("actual costs without an explicit tax basis are excluded", () => {
  const projection = buildJobEconomicsProjection(
    input({ costEvents: [cost({ amount_basis: undefined })] }),
  );
  assert.equal(projection.metrics.accrued_actual_cost.known_cents, 0);
  assert.equal(projection.metrics.accrued_actual_cost.complete, false);
  assert.ok(
    projection.reconciliation_gaps.includes(
      "job_cost_event.amount_basis_missing:cost:1",
    ),
  );
});

test("a reversal with different cost or source lineage is excluded", () => {
  const projection = buildJobEconomicsProjection(
    input({
      costEvents: [
        cost(),
        cost({
          name: "reversal:bad",
          job_cost_event_id: "reversal:bad",
          event_kind: "reversal",
          reversal_of: "cost:1",
          source_digest: "b".repeat(64),
        }),
      ],
    }),
  );
  assert.equal(projection.metrics.accrued_actual_cost.known_cents, 12_345);
  assert.ok(
    projection.reconciliation_gaps.includes(
      "job_cost_event.reversal_binding_mismatch:reversal:bad",
    ),
  );
});

test("mixed currencies and cross-tenant or cross-job events never enter one money claim", () => {
  const projection = buildJobEconomicsProjection(
    input({
      costEvents: [
        cost(),
        cost({ name: "OTHER-TENANT", job_cost_event_id: "OTHER-TENANT", tenant: "other" }),
        cost({ name: "OTHER-JOB", job_cost_event_id: "OTHER-JOB", roof_job: "JOB-2" }),
      ],
      paymentMilestones: [
        {
          name: "PAY-USD",
          roof_job: "JOB-1",
          status: "Matched",
          milestone_type: "Payment",
          total_amount: "10.00",
          currency: "USD",
        },
      ],
    }),
  );
  assert.equal(projection.currency, null);
  assert.equal(projection.metrics.accrued_actual_cost.known_cents, null);
  assert.ok(projection.reconciliation_gaps.includes("economics.mixed_currency"));
  assert.ok(projection.reconciliation_gaps.includes("job_cost_event.tenant_mismatch:OTHER-TENANT"));
  assert.ok(projection.reconciliation_gaps.includes("job_cost_event.job_mismatch:OTHER-JOB"));
});

test("missing material, labour, and machine rates are explicit coverage gaps", () => {
  const projection = buildJobEconomicsProjection(
    input({
      costEvents: [],
      materialLots: [
        { name: "LOT-1", roof_job: "JOB-1", status: "Available" },
      ],
      shopOrders: [
        { name: "SHOP-1", roof_job: "JOB-1", status: "In Fabrication" },
      ],
      fieldCheckins: [
        { name: "CHECK-1", roof_job: "JOB-1", sync_state: "Verified" },
      ],
    }),
  );
  assert.equal(projection.metrics.accrued_actual_cost.complete, false);
  assert.ok(projection.reconciliation_gaps.includes("material_lot.actual_cost_missing:LOT-1"));
  assert.ok(projection.reconciliation_gaps.includes("shop_order.labour_cost_missing:SHOP-1"));
  assert.ok(projection.reconciliation_gaps.includes("shop_order.machine_cost_missing:SHOP-1"));
  assert.ok(projection.reconciliation_gaps.includes("field_checkin.labour_cost_missing:CHECK-1"));
});

test("posted cost is distinct from accrued cost and requires complete reconciliation binding", () => {
  const projection = buildJobEconomicsProjection(
    input({
      costEvents: [
        cost({
          accounting_state: "Posted",
          accounting_system: "QuickBooks",
          accounting_entity_type: "Bill",
          accounting_entity_id: "77",
          accounting_digest: "c".repeat(64),
          accounting_posted_at: "2026-08-12T12:00:00Z",
          reconciliation: "RECON-77",
        }),
        cost({
          name: "cost:2",
          job_cost_event_id: "cost:2",
          amount_cents: 500,
          source_name: "LOT-2",
          accounting_state: "Posted",
        }),
      ],
      materialLots: [
        { name: "LOT-1", roof_job: "JOB-1", status: "Available" },
        { name: "LOT-2", roof_job: "JOB-1", status: "Available" },
      ],
      accountingReconciliations: [
        {
          name: "RECON-77",
          roof_job: "JOB-1",
          system_name: "QuickBooks",
          entity_type: "Bill",
          external_entity_id: "77",
          local_doctype: "Job Cost Event",
          local_name: "cost:1",
          status: "Matched",
          currency: "CAD",
          source_payload_hash: "c".repeat(64),
          detected_at: "2026-08-12T12:05:00Z",
        },
      ],
    }),
  );
  assert.equal(projection.metrics.accrued_actual_cost.known_cents, 12_845);
  assert.equal(projection.metrics.posted_actual_cost.known_cents, 12_345);
  assert.ok(projection.reconciliation_gaps.includes("job_cost_event.posted_binding_incomplete:cost:2"));
  assert.equal(projection.metrics.actual_profit.state, "unavailable");
});

test("actual profit is available only from posted recognized revenue minus posted actual cost", () => {
  const projection = buildJobEconomicsProjection(
    input({
      costEvents: [
        cost({
          accounting_state: "Posted",
          accounting_system: "QuickBooks",
          accounting_entity_type: "Bill",
          accounting_entity_id: "77",
          accounting_digest: "c".repeat(64),
          accounting_posted_at: "2026-08-12T12:00:00Z",
          reconciliation: "RECON-77",
        }),
      ],
      paymentMilestones: [
        {
          name: "INV-POSTED",
          payment_milestone_id: "INV-POSTED",
          roof_job: "JOB-1",
          milestone_type: "Invoice",
          milestone_version: 1,
          status: "Matched",
          currency: "CAD",
          subtotal: "200.00",
          tax_amount: "10.00",
          total_amount: "210.00",
          amount_due: "210.00",
          amount_paid: "0.00",
          balance_due: "210.00",
          payment_status: "Due",
          tax_code: "GST",
          tax_rate: "5",
          tax_policy_snapshot_json: "{\"rate\":5}",
          truth_source: "QuickBooks",
          truth_at: "2026-08-12T12:30:00Z",
          qb_entity_type: "Invoice",
          qb_entity_id: "42",
          recognition_posted_at: "2026-08-12T12:10:00Z",
          recognition_digest: "d".repeat(64),
          recognition_reconciliation: "RECON-42",
        },
        {
          name: "CREDIT-POSTED",
          payment_milestone_id: "CREDIT-POSTED",
          roof_job: "JOB-1",
          milestone_type: "Credit",
          milestone_version: 1,
          status: "Matched",
          currency: "CAD",
          subtotal: "20.00",
          tax_amount: "1.00",
          total_amount: "21.00",
          amount_due: "0.00",
          amount_paid: "0.00",
          balance_due: "0.00",
          payment_status: "Paid",
          tax_code: "GST",
          tax_rate: "5",
          tax_policy_snapshot_json: "{\"rate\":5}",
          truth_source: "QuickBooks",
          truth_at: "2026-08-12T12:40:00Z",
          qb_entity_type: "CreditMemo",
          qb_entity_id: "43",
          recognition_posted_at: "2026-08-12T12:20:00Z",
          recognition_digest: "e".repeat(64),
          recognition_reconciliation: "RECON-43",
        },
      ],
      accountingReconciliations: [
        {
          name: "RECON-77",
          roof_job: "JOB-1",
          system_name: "QuickBooks",
          entity_type: "Bill",
          external_entity_id: "77",
          local_doctype: "Job Cost Event",
          local_name: "cost:1",
          status: "Matched",
          currency: "CAD",
          source_payload_hash: "c".repeat(64),
          detected_at: "2026-08-12T12:05:00Z",
        },
        {
          name: "RECON-42",
          reconciliation_id: "RECON-42",
          roof_job: "JOB-1",
          system_name: "QuickBooks",
          entity_type: "Invoice",
          external_entity_id: "42",
          local_doctype: "Payment Milestone",
          local_name: "INV-POSTED",
          status: "Matched",
          currency: "CAD",
          source_payload_hash: "d".repeat(64),
          detected_at: "2026-08-12T12:15:00Z",
        },
        {
          name: "RECON-43",
          reconciliation_id: "RECON-43",
          roof_job: "JOB-1",
          system_name: "QuickBooks",
          entity_type: "CreditMemo",
          external_entity_id: "43",
          local_doctype: "Payment Milestone",
          local_name: "CREDIT-POSTED",
          status: "Resolved",
          currency: "CAD",
          source_payload_hash: "e".repeat(64),
          detected_at: "2026-08-12T12:25:00Z",
        },
      ],
    }),
  );
  assert.deepEqual(projection.metrics.actual_profit, {
    amount_cents: null,
    state: "unavailable",
    reason: "posted_revenue_recognition_unavailable",
  });
  assert.equal(projection.source_coverage.posted_revenue_milestones, 2);
  assert.ok(
    projection.reconciliation_gaps.includes(
      "actual_profit.posted_revenue_recognition_unavailable",
    ),
  );
});

test("matched invoices without exact posted revenue binding keep actual profit unavailable", () => {
  const projection = buildJobEconomicsProjection(
    input({
      paymentMilestones: [
        {
          name: "INV-MISSING-BINDING",
          payment_milestone_id: "INV-MISSING-BINDING",
          roof_job: "JOB-1",
          milestone_type: "Invoice",
          milestone_version: 1,
          status: "Matched",
          currency: "CAD",
          subtotal: "200.00",
          tax_amount: "10.00",
          total_amount: "210.00",
          amount_due: "210.00",
          amount_paid: "0.00",
          balance_due: "210.00",
          payment_status: "Due",
          tax_code: "GST",
          tax_rate: "5",
          tax_policy_snapshot_json: "{\"rate\":5}",
          truth_source: "QuickBooks",
          truth_at: "2026-08-12T12:30:00Z",
          qb_entity_type: "Invoice",
          qb_entity_id: "42",
        },
      ],
    }),
  );
  assert.equal(projection.metrics.actual_profit.state, "unavailable");
  assert.ok(
    projection.reconciliation_gaps.includes(
      "payment_milestone.posted_revenue_binding_incomplete:INV-MISSING-BINDING",
    ),
  );
});

test("posted revenue recognition rejects reconciliation evidence earlier than posting", () => {
  const projection = buildJobEconomicsProjection(
    input({
      paymentMilestones: [
        {
          name: "INV-EARLY-RECON",
          payment_milestone_id: "INV-EARLY-RECON",
          roof_job: "JOB-1",
          milestone_type: "Invoice",
          milestone_version: 1,
          status: "Matched",
          currency: "CAD",
          subtotal: "200.00",
          tax_amount: "10.00",
          total_amount: "210.00",
          amount_due: "210.00",
          amount_paid: "0.00",
          balance_due: "210.00",
          payment_status: "Due",
          tax_code: "GST",
          tax_rate: "5",
          tax_policy_snapshot_json: "{\"rate\":5}",
          truth_source: "QuickBooks",
          truth_at: "2026-08-12T12:30:00Z",
          qb_entity_type: "Invoice",
          qb_entity_id: "42",
          recognition_posted_at: "2026-08-12T12:10:00Z",
          recognition_digest: "d".repeat(64),
          recognition_reconciliation: "RECON-42",
        },
      ],
      accountingReconciliations: [
        {
          name: "RECON-42",
          reconciliation_id: "RECON-42",
          roof_job: "JOB-1",
          system_name: "QuickBooks",
          entity_type: "Invoice",
          external_entity_id: "42",
          local_doctype: "Payment Milestone",
          local_name: "INV-EARLY-RECON",
          status: "Matched",
          currency: "CAD",
          source_payload_hash: "d".repeat(64),
          detected_at: "2026-08-12T12:05:00Z",
        },
      ],
    }),
  );
  assert.equal(projection.metrics.actual_profit.state, "unavailable");
  assert.equal(projection.source_coverage.posted_revenue_milestones, 0);
  assert.ok(
    projection.reconciliation_gaps.includes(
      "payment_milestone.posted_revenue_binding_incomplete:INV-EARLY-RECON",
    ),
  );
});

test("posted revenue recognition rejects reconciliation evidence later than truth capture", () => {
  const projection = buildJobEconomicsProjection(
    input({
      paymentMilestones: [
        {
          name: "INV-LATE-RECON",
          payment_milestone_id: "INV-LATE-RECON",
          roof_job: "JOB-1",
          milestone_type: "Invoice",
          milestone_version: 1,
          status: "Matched",
          currency: "CAD",
          subtotal: "200.00",
          tax_amount: "10.00",
          total_amount: "210.00",
          amount_due: "210.00",
          amount_paid: "0.00",
          balance_due: "210.00",
          payment_status: "Due",
          tax_code: "GST",
          tax_rate: "5",
          tax_policy_snapshot_json: "{\"rate\":5}",
          truth_source: "QuickBooks",
          truth_at: "2026-08-12T12:30:00Z",
          qb_entity_type: "Invoice",
          qb_entity_id: "42",
          recognition_posted_at: "2026-08-12T12:10:00Z",
          recognition_digest: "d".repeat(64),
          recognition_reconciliation: "RECON-42",
        },
      ],
      accountingReconciliations: [
        {
          name: "RECON-42",
          reconciliation_id: "RECON-42",
          roof_job: "JOB-1",
          system_name: "QuickBooks",
          entity_type: "Invoice",
          external_entity_id: "42",
          local_doctype: "Payment Milestone",
          local_name: "INV-LATE-RECON",
          status: "Matched",
          currency: "CAD",
          source_payload_hash: "d".repeat(64),
          detected_at: "2026-08-12T12:35:00Z",
        },
      ],
    }),
  );
  assert.equal(projection.metrics.actual_profit.state, "unavailable");
  assert.equal(projection.source_coverage.posted_revenue_milestones, 0);
  assert.ok(
    projection.reconciliation_gaps.includes(
      "payment_milestone.posted_revenue_binding_incomplete:INV-LATE-RECON",
    ),
  );
});
