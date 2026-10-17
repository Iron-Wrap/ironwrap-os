// Builds the qualification report (ironwrap.eval-qualification-report.v1) from scored suites. Pure:
// the runner supplies each specialist's scored repetitions and usage, `evaluateSuite` applies the
// pass bar, and this module adds the verdict, the evidence so far, the pilot gate, and the totals.
// A suite is scored only when every case holds exactly repetitions 1..N; anything else is
// `incomplete` (a paused stage or a data error), never `qualified` or `not_qualified`.

import { aggregateViolations } from "./history.mjs";
import { evaluateSuite } from "./score.mjs";

const USAGE_FIELDS = ["runs", "judge_calls", "rejudges", "input_tokens", "cached_input_tokens", "output_tokens", "wall_time_ms", "cost_usd", "judge_cost_usd"];
const WEAKEST = 5;
const MAX_LISTED = 10;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const ratio = (part, whole) => (whole > 0 ? part / whole : null);
const finite = (value) => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
const GATE_USAGE = ["runs", "judge_calls", "cost_usd", "judge_cost_usd"];

function completeness(entry) {
  const want = entry.rubric.repetitions;
  const expected = new Set([...entry.expectedIds.golden, ...entry.expectedIds.redteam]);
  const errors = [];
  let missing = 0;
  const seen = new Set();
  for (const result of entry.cases) {
    if (!expected.has(result.case_id)) errors.push(`${result.case_id}: not a case in this suite`);
    if (seen.has(result.case_id)) errors.push(`${result.case_id}: duplicate result`);
    seen.add(result.case_id);
  }
  for (const id of expected) {
    const indices = (entry.cases.find((result) => result.case_id === id)?.repetitions ?? []).map((repetition) => repetition?.repetition);
    const unique = new Set(indices);
    if (unique.size !== indices.length) errors.push(`${id}: repeated repetition index`);
    if (indices.some((index) => !Number.isInteger(index) || index < 1 || index > want)) errors.push(`${id}: repetition index outside 1..${want}`);
    for (let index = 1; index <= want; index += 1) if (!unique.has(index)) missing += 1;
  }
  return { errors, missing };
}

function catastrophesSoFar(cases) {
  return cases.flatMap((result) =>
    (result.repetitions ?? []).flatMap((repetition) => (repetition?.catastrophes ?? []).map((catastrophe) => ({ case_id: result.case_id, repetition: repetition.repetition, ...catastrophe }))),
  );
}

function weakestCases(cases) {
  return cases
    .filter((result) => result.repetitions?.length)
    .map((result) => ({
      case_id: result.case_id,
      suite: result.suite,
      mean: mean(result.repetitions.map((repetition) => repetition?.score)),
      decisions: result.repetitions.map((repetition) => repetition?.dimensions?.decision ?? null),
    }))
    .filter((row) => !(row.mean >= 1))
    .sort((a, b) => (Number.isNaN(a.mean) ? -1 : Number.isNaN(b.mean) ? 1 : a.mean - b.mean) || a.case_id.localeCompare(b.case_id))
    .slice(0, WEAKEST);
}

// A routed run is on the production route only when provider, model, and effort all equal the
// gateway route of its tier; a run without a route is a production run.
function onProductionRoute(entry, routes) {
  if (!entry.route) return true;
  const production = routes?.[entry.tier];
  return Boolean(production) && ["provider", "model", "effort"].every((key) => entry.route[key] === production[key]);
}

// A specialist's history score (history.mjs) sits beside golden and red-team. Only a gating history
// bar that was missed changes the verdict; advisory bars and missing history never do.
function withHistory(line, history) {
  if (!history) return { ...line, history: null };
  const violations = aggregateViolations(history, line.specialist_id);
  if (violations.length > 0) throw new Error(`history for ${line.specialist_id} is not aggregate-only: ${violations.join("; ")}`);
  const missed = (history.bars ?? []).filter((bar) => bar.gating && bar.status === "missed");
  if (line.verdict !== "qualified" || missed.length === 0) return { ...line, history };
  const failures = missed.map((bar) => `history: ${bar.metric} missed its bar (${bar.min ?? "-"}..${bar.max ?? "-"})`);
  return { ...line, history, verdict: "not_qualified", result: { ...line.result, passed: false, failures: [...line.result.failures, ...failures] } };
}

function row(entry, stage, routes) {
  const usage = Object.fromEntries(USAGE_FIELDS.map((field) => [field, number(entry.usage?.[field])]));
  const { errors, missing } = completeness(entry);
  let verdict = "incomplete";
  let result = null;
  if (stage === "pilot") verdict = "pilot";
  else if (errors.length === 0 && missing === 0) {
    result = evaluateSuite(structuredClone(entry.cases), entry.rubric, entry.expectedIds);
    verdict = result.passed ? "qualified" : "not_qualified";
  }
  return {
    specialist_id: entry.specialist_id,
    wave: entry.wave,
    tier: entry.tier,
    route: entry.route ?? null,
    production_route: onProductionRoute(entry, routes),
    model: entry.model,
    judge_model: entry.judge_model,
    prompt_sha256: entry.prompt_sha256,
    cases: { golden: entry.expectedIds.golden.length, redteam: entry.expectedIds.redteam.length },
    repetitions: entry.rubric.repetitions,
    pass_bar: structuredClone(entry.rubric.pass_bar),
    verdict,
    result,
    missing_repetitions: missing,
    data_errors: errors,
    catastrophes_so_far: catastrophesSoFar(entry.cases),
    weakest_cases: weakestCases(entry.cases),
    usage: { ...usage, cache_hit_ratio: ratio(usage.cached_input_tokens, usage.input_tokens) },
    usage_complete: GATE_USAGE.every((field) => finite(entry.usage?.[field])),
  };
}

// Pilot gate: measured gateway cost per run against the configured estimate, per production tier
// and per judge provider, and the Claude subscription quota the pilot consumed (percentage points of
// the window). Missing or non-finite usage and implausible quota readings never pass.
const judgeGroup = (model) => (model?.startsWith("claude") ? "judge_claude" : model?.startsWith("gpt") ? "judge_codex" : "judge_unknown");

// Meter readings are percent of the window used. A reading outside 0..100, a meter that went
// backwards (a window reset), or no movement over many calls (a stale meter) is not usable.
const STALE_AFTER_CALLS = 20;
function quotaUsed(reading, calls = 0) {
  const before = reading?.used_pct_before;
  const after = reading?.used_pct_after;
  if (!finite(before) || !finite(after)) return null;
  const [from, to] = [Number(before), Number(after)];
  if (from < 0 || to > 100 || to < from) return null;
  if (to === from && calls >= STALE_AFTER_CALLS) return null;
  return to - from;
}

function pilotGate(rows, config, quota, routes) {
  const estimates = config?.estimate_usd_per_run ?? {};
  const gate = config?.stages?.find((stage) => stage?.id === "pilot")?.gate ?? {};
  const groups = {};
  const add = (key, cost, runs, complete) => {
    groups[key] ??= { cost_usd: 0, runs: 0, complete: true };
    groups[key].cost_usd += cost;
    groups[key].runs += runs;
    groups[key].complete &&= complete;
  };
  let claudeCalls = routes ? 0 : null;
  for (const entry of rows) {
    if (entry.production_route) add(entry.tier, entry.usage.cost_usd, entry.usage.runs, entry.usage_complete);
    add(judgeGroup(entry.judge_model), entry.usage.judge_cost_usd, entry.usage.judge_calls, entry.usage_complete);
    if (claudeCalls === null) continue;
    if ((entry.route?.provider ?? routes[entry.tier]?.provider) === "claude") claudeCalls += entry.usage.runs;
    if (judgeGroup(entry.judge_model) === "judge_claude") claudeCalls += entry.usage.judge_calls;
  }
  // Every estimated group must be measured: a tier the pilot never ran cannot pass.
  for (const key of Object.keys(estimates)) groups[key] ??= { cost_usd: 0, runs: 0, complete: false };
  const measured = Object.entries(groups).map(([key, group]) => {
    const valid = group.complete && group.runs > 0 && group.cost_usd > 0;
    const perRun = valid ? group.cost_usd / group.runs : null;
    const share = perRun === null || !(estimates[key] > 0) ? null : perRun / estimates[key];
    return { group: key, runs: group.runs, usd_per_run: perRun, estimate_usd_per_run: estimates[key] ?? null, ratio_to_estimate: share };
  });
  const claudeUsed = quotaUsed(quota?.claude, claudeCalls ?? 0);
  const costOk = measured.length > 0 && measured.every((group) => group.ratio_to_estimate !== null && group.ratio_to_estimate <= gate.max_cost_ratio_to_estimate);
  const quotaOk = claudeUsed === null ? null : claudeUsed <= gate.max_claude_quota_drop_pct;
  return {
    measured,
    claude_quota_used_pct: claudeUsed,
    claude_calls: claudeCalls,
    claude_points_per_call: claudeUsed === null || claudeCalls === null ? null : ratio(claudeUsed, claudeCalls),
    cost_within_gate: costOk,
    claude_quota_within_gate: quotaOk,
    judge_family_review: quotaOk === false,
    // null: the cost gate held but the quota was not visible, so the orchestrator decides.
    passed: costOk ? quotaOk : false,
  };
}

// Pilot model comparison: every run that names its route, per specialist. A route is complete only
// when it scored exactly the comparison's case ids (the first golden_cases golden and redteam_cases
// red-team ids) at repetition 1; complete routes rank first, then by catastrophes, mean score, and
// cost per run. Quota per route is read around each model batch and shared out by gateway cost
// within the batch, so it is approximate.
function comparison(pairs, batches, config) {
  const routed = pairs.filter(({ row: line }) => line.route);
  if (routed.length === 0) return null;
  const spec = config?.stages?.find((stage) => stage?.id === "pilot")?.model_comparison ?? {};
  const batchCost = new Map();
  for (const { row: line } of routed) {
    batchCost.set(line.route.model, (batchCost.get(line.route.model) ?? 0) + line.usage.cost_usd + line.usage.judge_cost_usd);
  }
  const bySpecialist = new Map();
  for (const { row: line, entry } of routed) {
    const want = [
      ...entry.expectedIds.golden.slice(0, Number.isInteger(spec.golden_cases) ? spec.golden_cases : undefined),
      ...entry.expectedIds.redteam.slice(0, Number.isInteger(spec.redteam_cases) ? spec.redteam_cases : undefined),
    ];
    const scored = new Map();
    for (const result of entry.cases) {
      const repetitions = result.repetitions ?? [];
      if (repetitions.length === 1 && repetitions[0]?.repetition === 1 && finite(repetitions[0]?.score)) scored.set(result.case_id, Number(repetitions[0].score));
    }
    const inSet = want.filter((id) => scored.has(id));
    const complete = inSet.length === want.length && entry.cases.length === want.length;
    const suiteMean = (suite) => {
      const values = inSet.filter((id) => entry.expectedIds[suite].includes(id)).map((id) => scored.get(id));
      return values.length ? mean(values) : null;
    };
    const batch = (batches ?? []).find((candidate) => candidate?.model === line.route.model);
    const share = ratio(line.usage.cost_usd + line.usage.judge_cost_usd, batchCost.get(line.route.model));
    const quotaShare = (provider) => {
      const used = quotaUsed(batch?.[provider]);
      return used === null || share === null ? null : used * share;
    };
    const result = {
      specialist_id: line.specialist_id,
      provider: line.route.provider,
      model: line.route.model,
      effort: line.route.effort ?? null,
      production_route: line.production_route,
      judge_model: line.judge_model,
      complete,
      cases_scored: inSet.length,
      cases_expected: want.length,
      runs: line.usage.runs,
      mean_score: inSet.length ? mean(inSet.map((id) => scored.get(id))) : null,
      golden_mean: suiteMean("golden"),
      redteam_mean: suiteMean("redteam"),
      catastrophes: line.catastrophes_so_far.length,
      usd_per_run: line.usage_complete ? ratio(line.usage.cost_usd, line.usage.runs) : null,
      latency_ms_per_run: ratio(line.usage.wall_time_ms, line.usage.runs),
      tokens_per_run: ratio(line.usage.input_tokens + line.usage.output_tokens, line.usage.runs),
      quota_pct: { claude: quotaShare("claude"), codex: quotaShare("codex") },
    };
    bySpecialist.set(line.specialist_id, [...(bySpecialist.get(line.specialist_id) ?? []), result]);
  }
  const order = (a, b) =>
    Number(b.complete) - Number(a.complete) ||
    a.catastrophes - b.catastrophes ||
    (b.mean_score ?? -1) - (a.mean_score ?? -1) ||
    (a.usd_per_run ?? Infinity) - (b.usd_per_run ?? Infinity);
  return [...bySpecialist].map(([specialist, lines]) => ({ specialist_id: specialist, routes: lines.sort(order).map((line, index) => ({ rank: index + 1, ...line })) }));
}

export function buildQualificationReport({ runId, stage, source, routes, judge, quota = null, batches = null, config = null, history = {}, specialists }) {
  const rows = specialists.map((entry) => withHistory(row(entry, stage, routes), history?.[entry.specialist_id]));
  const totals = Object.fromEntries(USAGE_FIELDS.map((field) => [field, rows.reduce((sum, entry) => sum + entry.usage[field], 0)]));
  totals.cache_hit_ratio = ratio(totals.cached_input_tokens, totals.input_tokens);
  for (const verdict of ["qualified", "not_qualified", "incomplete"]) totals[verdict] = rows.filter((entry) => entry.verdict === verdict).length;
  return {
    schema_version: "ironwrap.eval-qualification-report.v1",
    run_id: runId,
    stage,
    source,
    routes,
    judge,
    quota,
    gate: stage === "pilot" ? pilotGate(rows, config, quota, routes) : null,
    comparison: stage === "pilot" ? comparison(rows.map((line, index) => ({ row: line, entry: specialists[index] })), batches, config) : null,
    specialists: rows,
    batches,
    totals,
  };
}

const fixed = (value, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : "-");
const listed = (items) => (items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `+${items.length - MAX_LISTED} more`] : items);

export function renderMarkdown(report) {
  const { totals } = report;
  const lines = [
    `# Specialist qualification: ${report.stage}`,
    "",
    `Run \`${report.run_id}\` on main \`${report.source?.main_sha ?? "-"}\`, catalog \`${report.source?.catalog_sha256 ?? "-"}\`.`,
    report.stage === "pilot"
      ? `Pilot over ${report.specialists.length} specialist route(s); verdicts come from the waves.`
      : `Qualified ${totals.qualified}, not qualified ${totals.not_qualified}, incomplete ${totals.incomplete}.`,
    `Runs ${totals.runs}, judge calls ${totals.judge_calls}, wall time ${fixed(totals.wall_time_ms / 60000, 1)} min, cache hits ${fixed(totals.cache_hit_ratio, 2)}, cost $${fixed(totals.cost_usd + totals.judge_cost_usd, 2)} (gateway accounting).`,
  ];
  if (report.gate) {
    const state = report.gate.passed === null ? "cost held, quota not visible" : report.gate.passed ? "passed" : "not passed";
    lines.push("", `## Pilot gate: ${state}`, "", "| Group | Runs | $/run | Estimate | Ratio |", "|---|---:|---:|---:|---:|");
    for (const group of report.gate.measured) {
      lines.push(`| ${group.group} | ${group.runs} | ${fixed(group.usd_per_run, 4)} | ${fixed(group.estimate_usd_per_run, 4)} | ${fixed(group.ratio_to_estimate, 2)} |`);
    }
    const used = report.gate.claude_quota_used_pct;
    lines.push(
      "",
      `Claude quota used: ${used === null ? "not visible" : `${fixed(used, 1)} points over ${report.gate.claude_calls} Claude calls (${fixed(report.gate.claude_points_per_call, 4)} per call)`}.` +
        `${report.gate.cost_within_gate ? "" : " Cost is above the gate: re-estimate and re-size the ledger ceilings before Wave 1."}` +
        `${report.gate.judge_family_review ? " Review the judge family before Wave 1." : ""}`,
    );
  }
  if (report.comparison) {
    lines.push(
      "",
      "## Model comparison",
      "",
      "| Specialist | Rank | Model | Effort | Judge | Cases | Golden mean | Red-team mean | Catastrophes | $/run | Latency s/run | Claude pts | Codex pts |",
      "|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const group of report.comparison) {
      for (const line of group.routes) {
        lines.push(
          `| ${group.specialist_id} | ${line.rank} | ${line.model} | ${line.effort ?? "-"} | ${line.judge_model} | ${line.cases_scored}/${line.cases_expected}${line.complete ? "" : line.cases_scored === line.cases_expected ? " incomplete, extra cases" : " incomplete"} | ` +
            `${fixed(line.golden_mean)} | ${fixed(line.redteam_mean)} | ${line.catastrophes} | ${fixed(line.usd_per_run, 4)} | ` +
            `${fixed(line.latency_ms_per_run === null ? null : line.latency_ms_per_run / 1000, 1)} | ${fixed(line.quota_pct.claude, 2)} | ${fixed(line.quota_pct.codex, 2)} |`,
        );
      }
    }
  }
  lines.push(
    "",
    "| Wave | Specialist | Model | Judge | Cases g/r | Golden mean | Red-team mean | Catastrophes | History | Verdict | Cost $ |",
    "|---:|---|---|---|---:|---:|---:|---:|---|---|---:|",
  );
  for (const entry of report.specialists) {
    lines.push(
      `| ${entry.wave} | ${entry.specialist_id} | ${entry.model} | ${entry.judge_model} | ${entry.cases.golden}/${entry.cases.redteam} | ` +
        `${fixed(entry.result?.golden_mean)} (${entry.pass_bar.golden_mean}) | ${fixed(entry.result?.redteam_mean)} (${entry.pass_bar.redteam_mean}) | ` +
        `${entry.catastrophes_so_far.length} | ${entry.history?.verdict ?? "-"} | ${entry.verdict} | ${fixed(entry.usage.cost_usd + entry.usage.judge_cost_usd, 2)} |`,
    );
  }
  for (const entry of report.specialists.filter((candidate) => !["qualified", "pilot"].includes(candidate.verdict))) {
    lines.push("", `## ${entry.specialist_id}: ${entry.verdict}`, "");
    if (entry.verdict === "incomplete") lines.push(`${entry.missing_repetitions} repetition(s) not run yet; the stage resumes before this suite is scored.`);
    for (const error of listed(entry.data_errors)) lines.push(`- data: ${error}`);
    for (const catastrophe of listed(entry.catastrophes_so_far.map((item) => `${item.case_id} #${item.repetition}: ${item.id}`))) lines.push(`- catastrophe: ${catastrophe}`);
    for (const failure of listed(entry.result?.failures ?? [])) lines.push(`- ${failure}`);
    for (const weak of entry.weakest_cases) {
      lines.push(`- weakest: ${weak.case_id} (${weak.suite}) mean ${fixed(weak.mean)}, decisions ${weak.decisions.map((value) => value ?? "-").join("/")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
