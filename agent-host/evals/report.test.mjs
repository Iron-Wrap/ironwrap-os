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
  assert.match(markdown, /\| 1 \| orchestrator \| gpt-6\.1-sol \| claude-sonnet-5-5 \| 20\/10 \| 1\.000 \(0\.9\) \| 1\.000 \(0\.95\) \| 0 \| - \| qualified \| 6\.90 \|/);
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

test("pilot gate fails on absent usage, an empty pilot, or an implausible quota reading", () => {
  const config = {
    estimate_usd_per_run: { routine: 0.05, judge_claude: 0.027 },
    stages: [{ id: "pilot", gate: { max_cost_ratio_to_estimate: 1.5, max_claude_quota_drop_pct: 15 } }],
  };
  const build = (usage, quota) => {
    const entry = suite("orchestrator");
    entry.usage = usage;
    return buildQualificationReport({ runId: "p1", stage: "pilot", config, quota, specialists: [entry] }).gate;
  };
  const good = { runs: 8, judge_calls: 8, cost_usd: 0.48, judge_cost_usd: 0.2 };
  for (const cost of [undefined, Number.NaN, "n/a", null]) assert.equal(build({ ...good, cost_usd: cost }, null).passed, false);
  assert.equal(buildQualificationReport({ runId: "p1", stage: "pilot", config, specialists: [] }).gate.passed, false);
  for (const claude of [{}, { used_pct_before: 20, used_pct_after: null }, { used_pct_before: 90, used_pct_after: 5 }]) {
    const gate = build(good, { claude });
    assert.deepEqual([gate.claude_quota_used_pct, gate.passed], [null, null]);
  }
  const unknownJudge = suite("orchestrator");
  unknownJudge.judge_model = undefined;
  unknownJudge.usage = good;
  assert.equal(buildQualificationReport({ runId: "p1", stage: "pilot", config, specialists: [unknownJudge] }).gate.passed, false);
});

test("model comparison ranks complete routes first, then by catastrophes, score, and cost", () => {
  const config = { stages: [{ id: "pilot", model_comparison: { golden_cases: 10, redteam_cases: 4 } }] };
  const routes = { hard: { provider: "codex", model: "gpt-6-astra", effort: "high" } };
  const routed = (model, provider, { score = 1, cost = 1, catastrophe = false, scoredCases = 14, effort = "high" } = {}) => {
    const entry = suite("billing_reconciliation", { reps: 1 });
    entry.tier = "hard";
    entry.route = { provider, model, effort };
    entry.judge_model = provider === "claude" ? "gpt-6.1-sol" : "claude-sonnet-5-5";
    const want = [...entry.expectedIds.golden.slice(0, 10), ...entry.expectedIds.redteam.slice(0, 4)];
    entry.cases = entry.cases.filter((result) => want.slice(0, scoredCases).includes(result.case_id));
    for (const result of entry.cases) result.repetitions[0].score = score;
    if (catastrophe) entry.cases[0].repetitions[0].catastrophes = [{ id: "changes_payee_details" }];
    entry.usage = { runs: 14, judge_calls: 14, cost_usd: cost, judge_cost_usd: 0, wall_time_ms: 14 * 20000, input_tokens: 3000, output_tokens: 600 };
    return entry;
  };
  const report = buildQualificationReport({
    runId: "p1",
    stage: "pilot",
    config,
    routes,
    batches: [{ model: "gpt-6-astra", codex: { used_pct_before: 10, used_pct_after: 14 } }],
    specialists: [
      routed("gpt-6-astra", "codex", { score: 0.95, cost: 9 }),
      routed("claude-opus-5-5", "claude", { score: 0.97, cost: 3, catastrophe: true }),
      routed("gpt-6.1-sol", "codex", { score: 0.95, cost: 2 }),
      routed("gpt-6.1-sol", "codex", { score: 1, cost: 1, scoredCases: 3, effort: "low" }),
    ],
  });
  const [group] = report.comparison;
  assert.deepEqual(
    group.routes.map((line) => [line.rank, line.model, line.effort, line.complete, line.cases_scored, line.catastrophes, line.production_route]),
    [
      [1, "gpt-6.1-sol", "high", true, 14, 0, false],
      [2, "gpt-6-astra", "high", true, 14, 0, true],
      [3, "claude-opus-5-5", "high", true, 14, 1, false],
      [4, "gpt-6.1-sol", "low", false, 3, 0, false],
    ],
  );
  assert.deepEqual([group.routes[0].golden_mean, group.routes[0].redteam_mean], [0.95, 0.95]);
  assert.deepEqual(group.routes[1].quota_pct, { claude: null, codex: 4 });
  assert.equal(group.routes[0].latency_ms_per_run, 20000);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| billing_reconciliation \| 1 \| gpt-6\.1-sol \| high \| claude-sonnet-5-5 \| 14\/14 \| 0\.950 \| 0\.950 \| 0 \| 0\.1429 \| 20\.0 \| - \| - \|/);
  assert.match(markdown, /\| 4 \| gpt-6\.1-sol \| low \| claude-sonnet-5-5 \| 3\/14 incomplete \|/);
  assert.match(markdown, /Pilot over 4 specialist route\(s\)/);
});

test("pilot gate needs every estimated group measured and a plausible, moving quota meter", () => {
  const config = {
    estimate_usd_per_run: { routine: 0.05, hard: 0.32, judge_claude: 0.027 },
    stages: [{ id: "pilot", gate: { max_cost_ratio_to_estimate: 1.5, max_claude_quota_drop_pct: 15 } }],
  };
  const entry = suite("orchestrator");
  entry.usage = { runs: 8, judge_calls: 8, cost_usd: 0.48, judge_cost_usd: 0.2 };
  const gate = buildQualificationReport({ runId: "p1", stage: "pilot", config, specialists: [entry] }).gate;
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.measured.find((group) => group.group === "hard"), { group: "hard", runs: 0, usd_per_run: null, estimate_usd_per_run: 0.32, ratio_to_estimate: null });
  const routes = { routine: { provider: "codex", model: "sol", effort: "medium" } };
  const cheap = { ...config, estimate_usd_per_run: { routine: 0.05, judge_claude: 0.027 } };
  const quota = (claude) => buildQualificationReport({ runId: "p1", stage: "pilot", config: cheap, routes, quota: { claude }, specialists: [entry] }).gate;
  for (const claude of [{ used_pct_before: 5, used_pct_after: 999 }, { used_pct_before: -10, used_pct_after: -5 }, { used_pct_before: [], used_pct_after: " " }]) {
    assert.equal(quota(claude).claude_quota_used_pct, null);
  }
  const busy = suite("orchestrator");
  busy.usage = { runs: 8, judge_calls: 30, cost_usd: 0.48, judge_cost_usd: 0.75 };
  const stale = buildQualificationReport({ runId: "p1", stage: "pilot", config: cheap, routes, quota: { claude: { used_pct_before: 38, used_pct_after: 38 } }, specialists: [busy] }).gate;
  assert.deepEqual([stale.claude_calls, stale.claude_quota_used_pct, stale.passed], [30, null, null]);
  assert.equal(buildQualificationReport({ runId: "p1", stage: "pilot", config: cheap, quota: { claude: { used_pct_before: 1, used_pct_after: 2 } }, specialists: [entry] }).gate.claude_points_per_call, null);
});

test("a missed gating history bar fails an otherwise qualified suite; advisory bars do not; history must be aggregate-only", () => {
  const history = (gating) => ({
    specialist_id: "lead_concierge",
    verdict: gating ? "missed" : "advisory",
    bars: [{ metric: "converted_dropped.rate", max: 0.02, gating, value: null, status: "missed" }],
  });
  const lead = () => ({ ...suite("lead_concierge"), specialist_id: "lead_concierge" });
  const missed = buildQualificationReport({ runId: "q1", stage: "wave1", history: { lead_concierge: history(true) }, specialists: [lead()] });
  assert.equal(missed.specialists[0].verdict, "not_qualified");
  assert.ok(missed.specialists[0].result.failures.includes("history: converted_dropped.rate missed its bar (-..0.02)"));
  const advisory = buildQualificationReport({ runId: "q1", stage: "wave1", history: { lead_concierge: history(false) }, specialists: [lead()] });
  assert.equal(advisory.specialists[0].verdict, "qualified");
  assert.match(renderMarkdown(advisory), /\| 0 \| advisory \| qualified \|/);
  assert.throws(
    () => buildQualificationReport({ runId: "q1", stage: "wave1", history: { lead_concierge: { ...history(false), metrics: { leaked: "a name" } } }, specialists: [lead()] }),
    /not aggregate-only/,
  );
});
