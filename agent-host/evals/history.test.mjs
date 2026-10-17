import assert from "node:assert/strict";
import test from "node:test";

import { aggregateViolations, billingMetrics, distribution, estimatorMetrics, historyScore, leadMetrics, share, validMetricPath } from "./history.mjs";

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("raw distributions and shares; Wilson interval on shares", () => {
  assert.deepEqual(distribution([1, 2, 3, 4, 5]), { kind: "distribution", n: 5, mean: 3, p10: 1.4, p25: 2, p50: 3, p75: 4, p90: 4.6 });
  const s = share(0, 60);
  assert.equal(s.rate, 0);
  assert.ok(s.ci95[1] > 0.05 && s.ci95[1] < 0.07, "zero of sixty is still up to about six percent");
});

test("published metrics hide small groups, small cells, and quantiles a few values would reveal", () => {
  const rows = (n, below) => range(n, (i) => ({ predicted_total_cents: i < below ? 60000 : 100000 + i, quoted_total_cents: 100000, accepted_total_cents: 100000, actual_cost_cents: 70000 }));
  const bars = [{ metric: "below_actual_cost.rate", max: 0, gating: true }];
  const small = historyScore("estimator", rows(8, 2), bars);
  assert.deepEqual(small.metrics.below_actual_cost, { n: 8, small_cell: true });
  assert.deepEqual(Object.keys(small.metrics.abs_error_vs_quoted_pct), ["n", "mean"]);
  assert.deepEqual(small.bars[0], { metric: "below_actual_cost.rate", max: 0, gating: true, value: null, status: "missed" }, "the bar still decides on the raw value");
  assert.equal(small.verdict, "missed");
  const large = historyScore("estimator", rows(30, 0), bars);
  assert.deepEqual(Object.keys(large.metrics.abs_error_vs_quoted_pct), ["n", "mean", "p25", "p50", "p75", "p10", "p90"]);
  assert.equal(large.verdict, "met");
  assert.deepEqual(historyScore("estimator", rows(3, 0), bars).metrics.abstention, { n: 3, suppressed: true });
});

test("groups under five never decide a bar; ranking metrics need five on each side", () => {
  const jobs = [{ predicted_days: 5, actual_days: 3 }, { predicted_days: 3, actual_days: 3 }];
  const bars = [{ metric: "abs_error_pct.p50", max: 25, gating: true }, { metric: "abs_error_pct.p90", max: 60, gating: false }];
  const score = historyScore("scheduler_dispatcher", jobs, bars);
  assert.deepEqual(score.bars.map((bar) => [bar.status, bar.value]), [["insufficient", null], ["insufficient", null]]);
  const leads = range(60, (i) => ({ decision: i < 3 ? "qualified" : "nurture", converted: i < 2 }));
  const metrics = leadMetrics(leads);
  assert.deepEqual([metrics.auc.value, metrics.top_decile_lift.value], [null, null], "two converted leads rank nothing");
});

test("verdicts: no gating bars is advisory; a gating bar under min_n is insufficient", () => {
  const rows = range(30, (i) => ({ decision: i % 2 ? "qualified" : "nurture", converted: i % 2 === 1, days_to_convert: 10 }));
  assert.equal(historyScore("lead_concierge", rows, [{ metric: "auc", min: 0.7, gating: false }]).verdict, "advisory");
  const gated = historyScore("lead_concierge", rows, [{ metric: "converted_dropped.rate", max: 0.02, min_n: 100, gating: true }]);
  assert.deepEqual([gated.verdict, gated.bars[0].status], ["insufficient", "insufficient"]);
});

test("estimator: errors against quoted and accepted, margin error, and the person's own below-cost baseline", () => {
  const rows = [
    ...[100, 105, 95, 110, 90].map((p) => ({ predicted_total_cents: p * 1000, quoted_total_cents: 100000, accepted_total_cents: 100000, actual_cost_cents: 70000 })),
    { predicted_total_cents: 60000, quoted_total_cents: 65000, accepted_total_cents: 100000, actual_cost_cents: 70000 },
    { predicted_total_cents: 0, quoted_total_cents: 100000, actual_cost_cents: 70000 },
    { abstained: true },
  ];
  const metrics = estimatorMetrics(rows);
  assert.equal(metrics.abstention.count, 2, "a zero price counts as no price");
  assert.equal(metrics.below_actual_cost.count, 1);
  assert.equal(metrics.human_below_actual_cost.count, 1);
  assert.equal(metrics.margin_error_points.n, 6);
});

test("lead concierge: AUC and the top decile count ties fairly; prototype keys are not decisions", () => {
  const rows = [
    ...range(6, () => ({ decision: "qualified", converted: true, days_to_convert: 9 })),
    ...range(6, () => ({ decision: "nurture", converted: false })),
    { decision: "spam", converted: true },
    ...range(5, () => ({ decision: "disqualified", converted: false })),
    { decision: "toString", converted: true },
  ];
  const metrics = leadMetrics(rows);
  assert.equal(Math.round(metrics.auc.value * 1000) / 1000, 0.857);
  assert.equal(metrics.abstention.count, 1);
  assert.equal(metrics.converted_dropped.count, 1);
  const tied = leadMetrics(range(20, (i) => ({ decision: "qualified", converted: i < 10 })));
  assert.equal(tied.top_decile_lift.value, 1, "an all-tied ranking lifts nothing, whatever the input order");
});

test("billing: duplicates count once; a payer seen paying that customer is not cross-customer", () => {
  const actual = range(10, (i) => ({ payment: `pay-${i}`, invoice: `inv-${i}`, amount_cents: 5000, payment_customer: i === 0 ? "insurer" : `c-${i}`, invoice_customer: `c-${i}` }));
  const proposed = [
    ...actual.slice(0, 8),
    actual[1],
    actual[1],
    { ...actual[8], amount_cents: 4999 },
    { payment: "pay-x", invoice: "inv-9", amount_cents: 5000, payment_customer: "c-x", invoice_customer: "c-9" },
  ];
  const metrics = billingMetrics({ proposed, actual, payments: 12 });
  assert.equal(metrics.precision.value, 0.9);
  assert.equal(metrics.recall.value, 0.9);
  assert.equal(metrics.exact_amount.count, 8);
  assert.equal(metrics.cross_customer.count, 1, "the insurer paying c-0 is legitimate; c-x paying c-9 is not");
  assert.equal(metrics.false_application.count, 1);
});

test("aggregate check: keys, strings, suppression shape, and small cells", () => {
  assert.equal(validMetricPath("estimator", "abs_error_vs_quoted_pct.p50"), true);
  assert.equal(validMetricPath("estimator", "abs_error_vs_quoted_pct.p5O"), false);
  assert.equal(validMetricPath("lead_concierge", "auc"), true);
  assert.equal(validMetricPath("lead_concierge", "auc.value"), false);
  const violations = aggregateViolations(
    {
      specialist_id: "estimator",
      metrics: {
        abstention: { n: 3, suppressed: true, rows: [1] },
        below_actual_cost: { n: 40, count: 2, rate: 0.05 },
        human_below_actual_cost: { n: 100, rate: 0.03, ci95: [0.01, 0.08, 0.2] },
        margin_error_points: { n: 100, mean: 7805550142 },
        "person-abcdefghij": { n: 9 },
      },
      verdict: "Gordon",
    },
    "estimator",
  );
  assert.deepEqual(violations, [
    "$.metrics.abstention: suppressed must be exactly { n, suppressed: true }",
    "$.metrics.abstention: key is not allowed",
    "$.metrics.abstention.rows: unexpected list",
    "$.metrics.below_actual_cost: small cell",
    "$.metrics.human_below_actual_cost: small cell",
    "$.metrics.human_below_actual_cost.ci95: ci95 must be two shares",
    "$.metrics.margin_error_points.mean: number out of range",
    "$.metrics: key is not allowed",
    "$.verdict: string is not an allowed label",
  ]);
});
