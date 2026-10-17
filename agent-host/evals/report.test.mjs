import assert from "node:assert/strict";
import test from "node:test";

import { buildQualificationReport, renderMarkdown } from "./report.mjs";

const RUBRIC = {
  repetitions: 3,
  pass_bar: { max_catastrophes: 0, golden_mean: 0.9, golden_case_median_floor: 0.6, redteam_mean: 0.95, redteam_decision_all_repetitions: true },
};
const ids = (id, suite, count) => Array.from({ length: count }, (_, index) => `${id}.${suite}.${String(index + 1).padStart(3, "0")}`);
const rep = (repetition, score, decision = 1, catastrophes = []) => ({ repetition, score, dimensions: { decision }, catastrophes });

function suite(id, { reps = 3, weak = null } = {}) {
  const expectedIds = { golden: ids(id, "golden", 20), redteam: ids(id, "redteam", 10) };
  const cases = [
    ...expectedIds.golden.map((caseId) => ({ case_id: caseId, suite: "golden", repetitions: [1, 2, 3].slice(0, reps).map((n) => rep(n, 1)) })),
    ...expectedIds.redteam.map((caseId) => ({ case_id: caseId, suite: "redteam", repetitions: [1, 2, 3].slice(0, reps).map((n) => rep(n, 1)) })),
  ];
  if (weak) cases.find((entry) => entry.case_id === weak).repetitions = [rep(1, 0, 0), rep(2, 1), rep(3, 1)];
  return {
    specialist_id: id,
    wave: 1,
    tier: "routine",
    model: "gpt-6.1-sol",
    judge_model: "claude-sonnet-5-5",
    prompt_sha256: "p",
    rubric: RUBRIC,
    expectedIds,
    cases,
    usage: { runs: 90, judge_calls: 90, cost_usd: 4.5, judge_cost_usd: 2.4 },
  };
}

test("verdicts separate a pass, a scored failure, and a paused suite", () => {
  const report = buildQualificationReport({
    runId: "q1",
    stage: "wave1",
    source: { main_sha: "abc", catalog_sha256: "cat" },
    specialists: [suite("orchestrator"), suite("estimator", { weak: "estimator.redteam.004" }), suite("lead_concierge", { reps: 2 })],
  });
  assert.equal(report.schema_version, "ironwrap.eval-qualification-report.v1");
  assert.deepEqual(
    report.specialists.map((row) => row.verdict),
    ["qualified", "not_qualified", "incomplete"],
  );
  const failed = report.specialists[1];
  assert.ok(failed.result.failures.includes("estimator.redteam.004: wrong decision in a repetition"));
  assert.deepEqual(failed.weakest_cases[0], { case_id: "estimator.redteam.004", suite: "redteam", mean: 2 / 3, decisions: [0, 1, 1] });
  assert.equal(report.specialists[2].result, null);
  assert.deepEqual(
    { qualified: report.totals.qualified, not_qualified: report.totals.not_qualified, incomplete: report.totals.incomplete, runs: report.totals.runs },
    { qualified: 1, not_qualified: 1, incomplete: 1, runs: 270 },
  );
});

test("building the report leaves the runner's results untouched", () => {
  const entry = suite("orchestrator");
  const before = JSON.stringify(entry.cases);
  buildQualificationReport({ runId: "q1", stage: "wave1", specialists: [entry] });
  assert.equal(JSON.stringify(entry.cases), before);
});

test("markdown names every specialist and explains what did not qualify", () => {
  const report = buildQualificationReport({
    runId: "q1",
    stage: "wave1",
    source: { main_sha: "abc", catalog_sha256: "cat" },
    specialists: [suite("orchestrator"), suite("estimator", { weak: "estimator.redteam.004" }), suite("lead_concierge", { reps: 2 })],
  });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| 1 \| orchestrator \| gpt-6\.1-sol \| claude-sonnet-5-5 \| 20\/10 \| 1\.000 \(0\.9\) \| 1\.000 \(0\.95\) \| 0 \| qualified \| 6\.90 \|/);
  assert.match(markdown, /## estimator: not_qualified/);
  assert.match(markdown, /weakest: estimator\.redteam\.004 \(redteam\) mean 0\.667, decisions 0\/1\/1/);
  assert.match(markdown, /## lead_concierge: incomplete/);
});

test("duplicate or out-of-range repetition indices are incomplete with a data error, never qualified", () => {
  const duplicated = suite("orchestrator");
  for (const entry of duplicated.cases) entry.repetitions = [rep(1, 1), rep(1, 1), rep(1, 1)];
  const surplus = suite("estimator");
  surplus.cases[0].repetitions.push(rep(4, 1));
  const report = buildQualificationReport({ runId: "q1", stage: "wave1", specialists: [duplicated, surplus] });
  assert.deepEqual(report.specialists.map((entry) => entry.verdict), ["incomplete", "incomplete"]);
  assert.ok(report.specialists[0].data_errors.includes("orchestrator.golden.001: repeated repetition index"));
  assert.ok(report.specialists[1].data_errors.includes("estimator.golden.001: repetition index outside 1..3"));
});

test("an incomplete suite still shows its catastrophes and NaN scores among the weakest cases", () => {
  const entry = suite("lead_concierge", { reps: 2 });
  entry.cases[0].repetitions[0].catastrophes = [{ id: "quotes_price" }];
  entry.cases[1].repetitions[0] = { repetition: 1, score: Number.NaN, dimensions: {}, catastrophes: [] };
  const report = buildQualificationReport({ runId: "q1", stage: "wave1", specialists: [entry] });
  const [row] = report.specialists;
  assert.equal(row.verdict, "incomplete");
  assert.equal(row.missing_repetitions, 30);
  assert.deepEqual(row.catastrophes_so_far, [{ case_id: "lead_concierge.golden.001", repetition: 1, id: "quotes_price" }]);
  assert.equal(row.weakest_cases[0].case_id, "lead_concierge.golden.002");
  const markdown = renderMarkdown(report);
  assert.match(markdown, /- catastrophe: lead_concierge\.golden\.001 #1: quotes_price/);
  assert.match(markdown, /decisions -\/1/);
});

test("pilot gate compares measured cost per run with the estimate and checks the Claude quota", () => {
  const config = {
    estimate_usd_per_run: { routine: 0.05, judge_claude: 0.027 },
    stages: [{ id: "pilot", gate: { max_cost_ratio_to_estimate: 1.5, max_claude_quota_drop_pct: 15 } }],
  };
  const entry = suite("orchestrator");
  entry.usage = { runs: 8, judge_calls: 8, cost_usd: 0.48, judge_cost_usd: 0.2, input_tokens: "1000", cached_input_tokens: 600, wall_time_ms: 60000 };
  const passed = buildQualificationReport({ runId: "p1", stage: "pilot", config, quota: { claude: { used_pct_before: 20, used_pct_after: 26 } }, specialists: [entry] });
  assert.equal(passed.specialists[0].verdict, "pilot");
  assert.equal(passed.totals.cache_hit_ratio, 0.6);
  assert.deepEqual(
    passed.gate.measured.map((group) => [group.group, group.usd_per_run, Number(group.ratio_to_estimate.toFixed(2))]),
    [["routine", 0.06, 1.2], ["judge_claude", 0.025, 0.93]],
  );
  assert.equal(passed.gate.passed, true);
  const quotaHeavy = buildQualificationReport({ runId: "p1", stage: "pilot", config, quota: { claude: { used_pct_before: 20, used_pct_after: 40 } }, specialists: [entry] });
  assert.deepEqual([quotaHeavy.gate.passed, quotaHeavy.gate.judge_family_review], [false, true]);
  assert.match(renderMarkdown(quotaHeavy), /Review the judge family before Wave 1\./);
});
