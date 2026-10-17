// Builds the qualification report (ironwrap.eval-qualification-report.v1) from scored suites. Pure:
// the runner supplies each specialist's scored repetitions and usage, `evaluateSuite` applies the
// pass bar, and this module adds the verdict, the evidence so far, the pilot gate, and the totals.
// A suite is scored only when every case holds exactly repetitions 1..N; anything else is
// `incomplete` (a paused stage or a data error), never `qualified` or `not_qualified`.

import { evaluateSuite } from "./score.mjs";

const USAGE_FIELDS = ["runs", "judge_calls", "rejudges", "input_tokens", "cached_input_tokens", "output_tokens", "wall_time_ms", "cost_usd", "judge_cost_usd"];
const WEAKEST = 5;
const MAX_LISTED = 10;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const ratio = (part, whole) => (whole > 0 ? part / whole : null);

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

function row(entry, stage) {
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
  };
}

// Pilot gate: measured gateway cost per run against the configured estimate, per tier and per judge
// provider, and the Claude subscription quota the pilot consumed (percentage points of the window).
function pilotGate(rows, config, quota) {
  const estimates = config?.estimate_usd_per_run ?? {};
  const gate = config?.stages?.find((stage) => stage?.id === "pilot")?.gate ?? {};
  const groups = {};
  const add = (key, cost, runs) => {
    groups[key] ??= { cost_usd: 0, runs: 0 };
    groups[key].cost_usd += cost;
    groups[key].runs += runs;
  };
  for (const entry of rows) {
    add(entry.tier, entry.usage.cost_usd, entry.usage.runs);
    add(entry.judge_model?.startsWith("claude") ? "judge_claude" : "judge_codex", entry.usage.judge_cost_usd, entry.usage.judge_calls);
  }
  const measured = Object.entries(groups).map(([key, group]) => {
    const perRun = ratio(group.cost_usd, group.runs);
    const share = perRun === null || !(estimates[key] > 0) ? null : perRun / estimates[key];
    return { group: key, runs: group.runs, usd_per_run: perRun, estimate_usd_per_run: estimates[key] ?? null, ratio_to_estimate: share };
  });
  const claudeUsed = quota?.claude ? number(quota.claude.used_pct_after) - number(quota.claude.used_pct_before) : null;
  const costOk = measured.every((group) => group.ratio_to_estimate !== null && group.ratio_to_estimate <= gate.max_cost_ratio_to_estimate);
  // An invisible quota leaves the decision to the cost gate and the orchestrator.
  const quotaOk = claudeUsed === null ? null : claudeUsed <= gate.max_claude_quota_drop_pct;
  return { measured, claude_quota_used_pct: claudeUsed, cost_within_gate: costOk, claude_quota_within_gate: quotaOk, judge_family_review: quotaOk === false, passed: costOk && quotaOk !== false };
}

export function buildQualificationReport({ runId, stage, source, routes, judge, quota = null, config = null, specialists }) {
  const rows = specialists.map((entry) => row(entry, stage));
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
    gate: stage === "pilot" ? pilotGate(rows, config, quota) : null,
    specialists: rows,
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
    `Qualified ${totals.qualified}, not qualified ${totals.not_qualified}, incomplete ${totals.incomplete}.`,
    `Runs ${totals.runs}, judge calls ${totals.judge_calls}, wall time ${fixed(totals.wall_time_ms / 60000, 1)} min, cache hits ${fixed(totals.cache_hit_ratio, 2)}, cost $${fixed(totals.cost_usd + totals.judge_cost_usd, 2)} (gateway accounting).`,
  ];
  if (report.gate) {
    lines.push("", `## Pilot gate: ${report.gate.passed ? "passed" : "not passed"}`, "", "| Group | Runs | $/run | Estimate | Ratio |", "|---|---:|---:|---:|---:|");
    for (const group of report.gate.measured) {
      lines.push(`| ${group.group} | ${group.runs} | ${fixed(group.usd_per_run, 4)} | ${fixed(group.estimate_usd_per_run, 4)} | ${fixed(group.ratio_to_estimate, 2)} |`);
    }
    const used = report.gate.claude_quota_used_pct;
    lines.push("", `Claude quota used: ${used === null ? "not visible" : `${fixed(used, 1)} points`}.${report.gate.judge_family_review ? " Review the judge family before Wave 1." : ""}`);
  }
  lines.push(
    "",
    "| Wave | Specialist | Model | Judge | Cases g/r | Golden mean | Red-team mean | Catastrophes | Verdict | Cost $ |",
    "|---:|---|---|---|---:|---:|---:|---:|---|---:|",
  );
  for (const entry of report.specialists) {
    lines.push(
      `| ${entry.wave} | ${entry.specialist_id} | ${entry.model} | ${entry.judge_model} | ${entry.cases.golden}/${entry.cases.redteam} | ` +
        `${fixed(entry.result?.golden_mean)} (${entry.pass_bar.golden_mean}) | ${fixed(entry.result?.redteam_mean)} (${entry.pass_bar.redteam_mean}) | ` +
        `${entry.catastrophes_so_far.length} | ${entry.verdict} | ${fixed(entry.usage.cost_usd + entry.usage.judge_cost_usd, 2)} |`,
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
