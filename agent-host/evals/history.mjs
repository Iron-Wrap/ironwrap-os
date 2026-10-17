// History evaluation: deterministic scores of specialist proposals against what actually happened
// in IronWrap's own records. Pure functions only; the runner builds the cases from output/, runs the
// specialists on pseudonymised snapshots, and passes the extracted outcomes here.
//
// Metrics are computed raw, bars are applied to the raw values, and only then is everything
// published as aggregates: no record id, name, or free text, no share whose count or complement is
// between 1 and 4, and quantiles only over enough values that no single value can be read back.

export const MIN_BUCKET = 5;
const QUANTILE_MIN = 10; // p25, p50, p75
const TAIL_MIN = 20; // p10, p90

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

// Wilson 95% interval for a share.
function wilson(count, total) {
  if (total === 0) return null;
  const z = 1.96;
  const p = count / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  const denominator = 1 + (z * z) / total;
  return [Math.max(0, (centre - spread) / denominator), Math.min(1, (centre + spread) / denominator)];
}

/** Raw distribution: n, mean, and the 10/25/50/75/90th percentiles. */
export function distribution(values) {
  const clean = values.filter(isNumber).sort((a, b) => a - b);
  if (clean.length === 0) return { kind: "distribution", n: 0 };
  const out = { kind: "distribution", n: clean.length, mean: clean.reduce((sum, value) => sum + value, 0) / clean.length };
  for (const q of [0.1, 0.25, 0.5, 0.75, 0.9]) out[`p${Math.round(q * 100)}`] = quantile(clean, q);
  return out;
}

/** Raw share with its Wilson 95% interval. */
export function share(count, total) {
  return { kind: "share", n: total, count, rate: total > 0 ? count / total : null, ci95: wilson(count, total) };
}

const scalar = (value, n) => ({ kind: "scalar", n, value: isNumber(value) ? value : null });
const pct = (predicted, actual) => (isNumber(predicted) && isNumber(actual) && actual !== 0 ? ((predicted - actual) / actual) * 100 : null);

/**
 * Estimator: one row per past job.
 * { abstained, predicted_total_cents, quoted_total_cents, accepted_total_cents, actual_cost_cents }
 * The person's own quote below cost is the baseline for the specialist's.
 */
export function estimatorMetrics(rows) {
  const priced = rows.filter((row) => !row.abstained && isNumber(row.predicted_total_cents) && row.predicted_total_cents > 0);
  const vsQuoted = priced.map((row) => pct(row.predicted_total_cents, row.quoted_total_cents)).filter(isNumber);
  const vsAccepted = priced.map((row) => pct(row.predicted_total_cents, row.accepted_total_cents)).filter(isNumber);
  const costed = priced.filter((row) => isNumber(row.actual_cost_cents) && row.actual_cost_cents > 0);
  const margin = (total, cost) => ((total - cost) / total) * 100;
  const marginError = costed
    .filter((row) => isNumber(row.accepted_total_cents) && row.accepted_total_cents > 0)
    .map((row) => margin(row.predicted_total_cents, row.actual_cost_cents) - margin(row.accepted_total_cents, row.actual_cost_cents));
  const humanCosted = costed.filter((row) => isNumber(row.quoted_total_cents) && row.quoted_total_cents > 0);
  return {
    abstention: share(rows.length - priced.length, rows.length),
    error_vs_quoted_pct: distribution(vsQuoted),
    abs_error_vs_quoted_pct: distribution(vsQuoted.map(Math.abs)),
    error_vs_accepted_pct: distribution(vsAccepted),
    margin_error_points: distribution(marginError),
    below_actual_cost: share(costed.filter((row) => row.predicted_total_cents < row.actual_cost_cents).length, costed.length),
    human_below_actual_cost: share(humanCosted.filter((row) => row.quoted_total_cents < row.actual_cost_cents).length, humanCosted.length),
  };
}

// Ranking metrics need at least MIN_BUCKET records on each side.
const ranked = (rows) => rows.filter((row) => row.positive).length >= MIN_BUCKET && rows.filter((row) => !row.positive).length >= MIN_BUCKET;

// Area under the ROC curve of `score` for `positive`, ties counted half (Mann-Whitney).
function auc(rows) {
  if (!ranked(rows)) return null;
  const positives = rows.filter((row) => row.positive).map((row) => row.score);
  const negatives = rows.filter((row) => !row.positive).map((row) => row.score);
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

// Positive rate in the top tenth by score; a tie group at the cut counts at its own average rate.
// It depends on the base rate, so compare it only between runs on the same sample.
function topDecileLift(rows) {
  if (!ranked(rows)) return null;
  const base = rows.filter((row) => row.positive).length / rows.length;
  const slots = Math.max(1, Math.round(rows.length / 10));
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const cut = sorted[slots - 1].score;
  const above = sorted.filter((row) => row.score > cut);
  const tied = sorted.filter((row) => row.score === cut);
  const positives = above.filter((row) => row.positive).length + ((slots - above.length) * tied.filter((row) => row.positive).length) / tied.length;
  return positives / slots / base;
}

const LEAD_SCORE = { spam: 0, disqualified: 1, nurture: 2, qualified: 3 };

/**
 * Lead concierge: one row per past lead.
 * { abstained, decision: "qualified" | "nurture" | "disqualified" | "spam", converted, days_to_convert }
 */
export function leadMetrics(rows) {
  const decided = rows.filter((row) => !row.abstained && Object.hasOwn(LEAD_SCORE, row.decision));
  const scored = decided.map((row) => ({ score: LEAD_SCORE[row.decision], positive: Boolean(row.converted) }));
  const converted = decided.filter((row) => row.converted);
  return {
    abstention: share(rows.length - decided.length, rows.length),
    auc: scalar(auc(scored), decided.length),
    top_decile_lift: scalar(topDecileLift(scored), decided.length),
    converted_marked_qualified: share(converted.filter((row) => row.decision === "qualified").length, converted.length),
    converted_dropped: share(converted.filter((row) => row.decision === "spam" || row.decision === "disqualified").length, converted.length),
    days_to_convert_qualified: distribution(converted.filter((row) => row.decision === "qualified").map((row) => row.days_to_convert)),
  };
}

/**
 * Billing reconciliation: proposed and actual payment applications for the same past payments,
 * each { payment, invoice, amount_cents, payment_customer, invoice_customer } with token ids. A
 * match is the pair (payment, invoice); duplicates count once. A payer other than the invoice's
 * customer is legitimate when the records show that payer paying that customer's invoices
 * (an insurer, a general contractor); otherwise it is a cross-customer application.
 */
export function billingMetrics({ proposed, actual, payments }) {
  const key = (row) => `${row.payment}|${row.invoice}`;
  const unique = (rows) => [...new Map(rows.map((row) => [key(row), row])).values()];
  const truth = new Map(unique(actual).map((row) => [key(row), row]));
  const proposals = unique(proposed);
  const correct = proposals.filter((row) => truth.has(key(row)));
  const exact = correct.filter((row) => row.amount_cents === truth.get(key(row)).amount_cents);
  const payers = new Set([...truth.values()].map((row) => `${row.payment_customer}|${row.invoice_customer}`));
  const applied = new Set([...truth.values()].map((row) => row.payment));
  const proposedPayments = new Set(proposals.map((row) => row.payment));
  return {
    payments: scalar(payments, payments),
    precision: scalar(proposals.length ? correct.length / proposals.length : null, proposals.length),
    recall: scalar(truth.size ? correct.length / truth.size : null, truth.size),
    exact_amount: share(exact.length, correct.length),
    cross_customer: share(proposals.filter((row) => row.payment_customer !== row.invoice_customer && !payers.has(`${row.payment_customer}|${row.invoice_customer}`)).length, proposals.length),
    // Payments the specialist applied although nobody ever applied them.
    false_application: share([...proposedPayments].filter((payment) => !applied.has(payment)).length, proposedPayments.size),
  };
}

/** Scheduler: one row per past job, { abstained, predicted_days, actual_days }. */
export function durationMetrics(rows) {
  const predicted = rows.filter((row) => !row.abstained && isNumber(row.predicted_days) && isNumber(row.actual_days) && row.actual_days > 0);
  const errors = predicted.map((row) => pct(row.predicted_days, row.actual_days));
  return {
    abstention: share(rows.length - predicted.length, rows.length),
    error_pct: distribution(errors),
    abs_error_pct: distribution(errors.map(Math.abs)),
  };
}

const METRICS = { estimator: estimatorMetrics, lead_concierge: leadMetrics, billing_reconciliation: billingMetrics, scheduler_dispatcher: durationMetrics };
const EMPTY = { billing_reconciliation: { proposed: [], actual: [], payments: 0 } };
const LEAVES = { distribution: ["mean", "p10", "p25", "p50", "p75", "p90"], share: ["rate"], scalar: [] };

/** Metric name → kind for a specialist, or null without history metrics. */
export function metricKinds(specialistId) {
  if (!METRICS[specialistId]) return null;
  return Object.fromEntries(Object.entries(METRICS[specialistId](EMPTY[specialistId] ?? [])).map(([name, metric]) => [name, metric.kind]));
}

/** Whether `path` ("name" or "name.leaf") names a numeric value of a metric of that kind. */
export function validMetricPath(specialistId, path) {
  const kinds = metricKinds(specialistId);
  const [name, leaf, extra] = String(path).split(".");
  if (!kinds || !Object.hasOwn(kinds, name) || extra !== undefined) return false;
  return kinds[name] === "scalar" ? leaf === undefined : LEAVES[kinds[name]].includes(leaf);
}

function rawValue(metrics, path) {
  const [name, leaf] = path.split(".");
  const metric = metrics[name];
  if (!metric) return { value: null, n: 0 };
  return { value: metric.kind === "scalar" ? metric.value : metric[leaf] ?? null, n: metric.n };
}

// The published form of one metric; anything a small group could reveal is left out.
function publish(metric) {
  if (metric.n < MIN_BUCKET) return { n: metric.n, suppressed: true };
  if (metric.kind === "scalar") return { n: metric.n, value: metric.value };
  if (metric.kind === "share") {
    const small = (metric.count > 0 && metric.count < MIN_BUCKET) || (metric.n - metric.count > 0 && metric.n - metric.count < MIN_BUCKET);
    return small ? { n: metric.n, small_cell: true } : { n: metric.n, count: metric.count, rate: metric.rate, ci95: metric.ci95 };
  }
  const out = { n: metric.n, mean: metric.mean };
  if (metric.n >= QUANTILE_MIN) Object.assign(out, { p25: metric.p25, p50: metric.p50, p75: metric.p75 });
  if (metric.n >= TAIL_MIN) Object.assign(out, { p10: metric.p10, p90: metric.p90 });
  return out;
}

const isPublished = (metric, path) => {
  const leaf = path.split(".")[1];
  const shown = publish(metric);
  return leaf ? shown[leaf] !== undefined : shown.value !== undefined;
};

/**
 * Applies bars to the raw metrics. A bar is "insufficient" when its metric has no value or fewer
 * than MIN_BUCKET or `min_n` records; its published `value` is null whenever the metric is
 * suppressed.
 */
export function applyBars(metrics, bars) {
  return bars.map(({ metric, min, max, min_n: minN, gating = false }) => {
    const { value, n } = rawValue(metrics, metric);
    const bar = { metric, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), ...(minN === undefined ? {} : { min_n: minN }), gating };
    if (!isNumber(value) || n < Math.max(MIN_BUCKET, minN ?? 0)) return { ...bar, value: null, status: "insufficient" };
    const ok = (max === undefined || value <= max) && (min === undefined || value >= min);
    return { ...bar, value: isPublished(metrics[metric.split(".")[0]], metric) ? value : null, status: ok ? "met" : "missed" };
  });
}

/** Verdict from the bars: gating bars decide; without gating bars the score is advisory. */
export function verdictOf(bars) {
  const gating = bars.filter((bar) => bar.gating);
  if (gating.length === 0) return "advisory";
  if (gating.some((bar) => bar.status === "missed")) return "missed";
  if (gating.some((bar) => bar.status === "insufficient")) return "insufficient";
  return "met";
}

/** The published history section of one specialist; throws if anything but aggregates remains. */
export function historyScore(specialistId, input, bars) {
  const compute = METRICS[specialistId];
  if (!compute) throw new Error(`no history metrics for ${specialistId}`);
  const raw = compute(input);
  const results = applyBars(raw, bars);
  const tally = Object.fromEntries(["met", "missed", "insufficient"].map((status) => [status, results.filter((bar) => bar.status === status).length]));
  const score = {
    specialist_id: specialistId,
    metrics: Object.fromEntries(Object.entries(raw).map(([name, metric]) => [name, publish(metric)])),
    bars: results,
    verdict: verdictOf(results),
    tally,
  };
  const violations = aggregateViolations(score, specialistId);
  if (violations.length > 0) throw new Error(`history score for ${specialistId} is not aggregate-only: ${violations.join("; ")}`);
  return score;
}

const KEYS = new Set([
  "specialist_id", "metrics", "bars", "verdict", "tally", "met", "missed", "insufficient",
  "n", "count", "rate", "ci95", "value", "mean", "p10", "p25", "p50", "p75", "p90", "suppressed", "small_cell",
  "metric", "min", "max", "min_n", "gating", "status",
]);
const LABELS = new Set(["met", "missed", "insufficient", "advisory"]);
const LARGEST = 1e6;

/**
 * Everything in a history section that is not an aggregate: unknown keys or strings, lists other
 * than `bars` and a two-number `ci95`, numbers too large to be a metric, and small groups or cells
 * (a cell is read from `count`, or from `rate` times `n`).
 */
export function aggregateViolations(score, specialistId) {
  const kinds = metricKinds(specialistId) ?? {};
  const found = [];
  const walk = (value, path, parentKey) => {
    if (typeof value === "string") {
      const ok = (parentKey === "specialist_id" && value === specialistId) || (["verdict", "status"].includes(parentKey) && LABELS.has(value)) || (parentKey === "metric" && validMetricPath(specialistId, value));
      if (!ok) found.push(`${path}: string is not an allowed label`);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) found.push(`${path}: not a finite number`);
      else if (Math.abs(value) > LARGEST) found.push(`${path}: number out of range`);
    } else if (Array.isArray(value)) {
      if (parentKey !== "ci95" && parentKey !== "bars") found.push(`${path}: unexpected list`);
      if (parentKey === "ci95" && !(value.length === 2 && value.every((item) => isNumber(item) && item >= 0 && item <= 1))) found.push(`${path}: ci95 must be two shares`);
      value.forEach((item, index) => walk(item, `${path}[${index}]`, parentKey === "bars" ? "bar" : parentKey));
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (value.suppressed !== undefined && !(entries.length === 2 && value.suppressed === true && typeof value.n === "number")) found.push(`${path}: suppressed must be exactly { n, suppressed: true }`);
      if (typeof value.n === "number" && value.n > 0 && value.n < MIN_BUCKET && value.suppressed !== true) found.push(`${path}: group of ${value.n}`);
      const count = typeof value.count === "number" ? value.count : isNumber(value.rate) && isNumber(value.n) ? Math.round(value.rate * value.n) : null;
      if (count !== null && ((count > 0 && count < MIN_BUCKET) || (value.n - count > 0 && value.n - count < MIN_BUCKET))) found.push(`${path}: small cell`);
      for (const [key, item] of entries) {
        if (!KEYS.has(key) && !(parentKey === "metrics" && Object.hasOwn(kinds, key))) found.push(`${path}: key is not allowed`);
        walk(item, `${path}.${key}`, key);
      }
    }
  };
  walk(score, "$", null);
  return found;
}
