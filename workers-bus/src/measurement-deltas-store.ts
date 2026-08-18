// measurement-deltas-store.ts - immutable, tenant-bound calibration evidence.

export const MEASUREMENT_CALIBRATION_MIN_SAMPLE_SIZE = 30;
export const MEASUREMENT_CALIBRATION_SUMMARY_DAYS = 90;
export const MEASUREMENT_CALIBRATION_DRIFT_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DELTA_BATCH = 100;

export type MeasurementErrorKind = "relative_fraction" | "absolute_unit";

export interface MeasurementDeltaRow {
  receipt_id: string;
  measurement_id: string;
  job_number: string | null;
  provider: string;
  source: string;
  check_name: string;
  /** '' for informational rows; metric name for numeric comparisons. */
  metric: string;
  ok: boolean;
  primary_value: number | null;
  independent_value: number | null;
  rel_diff: number | null;
  abs_diff: number | null;
  detail: string;
}

export interface MeasurementDeltaRecord extends MeasurementDeltaRow {
  id: number;
  tenant_id: string;
  error_kind: MeasurementErrorKind | "";
  signed_error: number | null;
  created_at: string;
}

export interface MeasurementDeltaAggregate {
  tenant_id: string;
  provider: string;
  source: string;
  metric: string;
  error_kind: MeasurementErrorKind;
  total: number;
  ok_count: number;
  status: "sufficient_data" | "insufficient_data";
  success_rate: number | null;
  mean_signed_bias: number | null;
  median_absolute_error: number | null;
  p50_absolute_error: number | null;
  p90_absolute_error: number | null;
  p95_absolute_error: number | null;
  sample_stddev: number | null;
  mean_signed_bias_ci95: { lower: number; upper: number } | null;
  tolerance_candidate: {
    status: "approval_required";
    basis: "observed_p95_absolute_error";
    value: number;
    automatic_promotion: false;
  } | null;
  drift: {
    status: "sufficient_data" | "insufficient_data";
    current_count: number;
    previous_count: number;
    mean_signed_bias_delta: number | null;
    p90_absolute_error_delta: number | null;
  };
}

export interface MeasurementCalibrationReport {
  tenant_id: string;
  as_of: string;
  minimum_sample_size: number;
  automatic_tolerance_promotion: false;
  confidence_interval: {
    level: 0.95;
    method: "normal_approximation_for_mean_signed_error";
    formula: "mean_signed_error +/- 1.96 * sample_stddev / sqrt(n)";
    population: "valid_signed_errors_in_summary_window";
  };
  summary_window: { days: number; start_exclusive: string; end_inclusive: string };
  drift_windows: {
    days_each: number;
    previous: { start_exclusive: string; end_inclusive: string };
    current: { start_exclusive: string; end_inclusive: string };
  };
  cohorts: MeasurementDeltaAggregate[];
}

type PersistedDelta = Omit<MeasurementDeltaRecord, "id" | "created_at">;

type AggregateDbRow = {
  tenant_id: string;
  provider: string;
  source: string;
  metric: string;
  error_kind: MeasurementErrorKind;
  total: number;
  ok_count: number;
  signed_sum: number;
  signed_square_sum: number;
  median_absolute_error: number;
  p50_absolute_error: number;
  p90_absolute_error: number;
  p95_absolute_error: number;
};

function configuredTenant(env: Env): string {
  const tenant = ((env as Env & { APP_TENANT_ID?: string }).APP_TENANT_ID ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant))
    throw new Error("measurement_delta_tenant_not_configured");
  return tenant;
}

function finite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function boundedText(value: unknown, name: string, max: number, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error(`measurement_delta_invalid_${name}`);
}

function rounded(value: number, digits = 12): number {
  const result = Number(value.toFixed(digits));
  return Object.is(result, -0) ? 0 : result;
}

function sameNumber(left: number | null, right: number | null): boolean {
  return left === right;
}

function normalizeRow(tenantId: string, row: MeasurementDeltaRow): PersistedDelta {
  boundedText(row.receipt_id, "receipt_id", 160);
  boundedText(row.measurement_id, "measurement_id", 160);
  boundedText(row.job_number, "job_number", 128, true);
  boundedText(row.provider, "provider", 64);
  boundedText(row.source, "source", 64);
  boundedText(row.check_name, "check_name", 128);
  if (typeof row.metric !== "string" || row.metric.length > 128)
    throw new Error("measurement_delta_invalid_metric");
  boundedText(row.detail, "detail", 2_000);
  if (typeof row.ok !== "boolean") throw new Error("measurement_delta_invalid_ok");

  const numericValues = [row.primary_value, row.independent_value, row.rel_diff, row.abs_diff];
  if (numericValues.some((value) => value !== null && !finite(value)))
    throw new Error("measurement_delta_nonfinite");

  if (!row.metric) {
    if (numericValues.some((value) => value !== null))
      throw new Error("measurement_delta_informational_values_forbidden");
    return { ...row, tenant_id: tenantId, error_kind: "", signed_error: null };
  }

  if (!finite(row.primary_value) || !finite(row.independent_value))
    throw new Error("measurement_delta_numeric_values_required");
  const relDiff = row.rel_diff;
  const absDiff = row.abs_diff;
  const relative = finite(relDiff);
  const absolute = finite(absDiff);
  if (
    relative === absolute ||
    (finite(relDiff) && relDiff < 0) ||
    (finite(absDiff) && absDiff < 0)
  )
    throw new Error("measurement_delta_exactly_one_error_required");

  if (finite(relDiff)) {
    if (row.primary_value === 0) throw new Error("measurement_delta_relative_zero_primary");
    const signedError = rounded((row.independent_value - row.primary_value) / row.primary_value, 6);
    if (Math.abs(Math.abs(signedError) - relDiff) > 0.000001)
      throw new Error("measurement_delta_relative_mismatch");
    return {
      ...row,
      tenant_id: tenantId,
      error_kind: "relative_fraction",
      signed_error: signedError,
    };
  }

  if (!finite(absDiff)) throw new Error("measurement_delta_exactly_one_error_required");
  const signedError = rounded(row.independent_value - row.primary_value, 4);
  if (Math.abs(Math.abs(signedError) - absDiff) > 0.0001)
    throw new Error("measurement_delta_absolute_mismatch");
  return {
    ...row,
    tenant_id: tenantId,
    error_kind: "absolute_unit",
    signed_error: signedError,
  };
}

function replayMatches(stored: PersistedDelta, candidate: PersistedDelta): boolean {
  return stored.tenant_id === candidate.tenant_id &&
    stored.receipt_id === candidate.receipt_id &&
    stored.measurement_id === candidate.measurement_id &&
    stored.job_number === candidate.job_number &&
    stored.provider === candidate.provider &&
    stored.source === candidate.source &&
    stored.check_name === candidate.check_name &&
    stored.metric === candidate.metric &&
    stored.ok === candidate.ok &&
    sameNumber(stored.primary_value, candidate.primary_value) &&
    sameNumber(stored.independent_value, candidate.independent_value) &&
    sameNumber(stored.rel_diff, candidate.rel_diff) &&
    sameNumber(stored.abs_diff, candidate.abs_diff) &&
    stored.detail === candidate.detail &&
    stored.error_kind === candidate.error_kind &&
    sameNumber(stored.signed_error, candidate.signed_error);
}

export async function recordMeasurementDeltas(
  env: Env,
  rows: MeasurementDeltaRow[],
  now = new Date(),
): Promise<void> {
  if (!rows.length) return;
  if (rows.length > MAX_DELTA_BATCH) throw new Error("measurement_delta_batch_too_large");
  if (!Number.isFinite(now.getTime())) throw new Error("measurement_delta_invalid_timestamp");
  const tenantId = configuredTenant(env);
  const candidates = rows.map((row) => normalizeRow(tenantId, row));
  const createdAt = now.toISOString();

  for (const row of candidates) {
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO measurement_deltas
         (tenant_id, receipt_id, measurement_id, job_number, provider, source, check_name, metric,
          ok, primary_value, independent_value, rel_diff, abs_diff, detail,
          error_kind, signed_error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      row.tenant_id, row.receipt_id, row.measurement_id, row.job_number, row.provider,
      row.source, row.check_name, row.metric, row.ok ? 1 : 0, row.primary_value,
      row.independent_value, row.rel_diff, row.abs_diff, row.detail, row.error_kind,
      row.signed_error, createdAt,
    ).run();
    if (Number(result.meta?.changes ?? 0) > 0) continue;

    const stored = await env.DB.prepare(
      `SELECT tenant_id, receipt_id, measurement_id, job_number, provider, source, check_name,
              metric, ok, primary_value, independent_value, rel_diff, abs_diff, detail,
              error_kind, signed_error
         FROM measurement_deltas
        WHERE tenant_id = ? AND receipt_id = ? AND check_name = ? AND metric = ?
        LIMIT 1`,
    ).bind(row.tenant_id, row.receipt_id, row.check_name, row.metric)
      .first<Omit<PersistedDelta, "ok"> & { ok: number }>();
    const normalizedStored = stored ? { ...stored, ok: !!stored.ok } : null;
    if (!normalizedStored || !replayMatches(normalizedStored, row))
      throw new Error("measurement_delta_immutable_conflict");
  }
}

export async function listMeasurementDeltas(env: Env, limit: number): Promise<MeasurementDeltaRecord[]> {
  const tenantId = configuredTenant(env);
  const { results } = await env.DB.prepare(
    `SELECT id, tenant_id, receipt_id, measurement_id, job_number, provider, source, check_name,
            metric, ok, primary_value, independent_value, rel_diff, abs_diff, detail,
            error_kind, signed_error, created_at
       FROM measurement_deltas
      WHERE tenant_id = ?
      ORDER BY id DESC LIMIT ?`,
  ).bind(tenantId, limit).all<Omit<MeasurementDeltaRecord, "ok"> & { ok: number }>();
  return (results ?? []).map((row) => ({ ...row, ok: !!row.ok }));
}

function cohortKey(row: Pick<AggregateDbRow, "provider" | "source" | "metric" | "error_kind">): string {
  return JSON.stringify([row.provider, row.source, row.metric, row.error_kind]);
}

async function aggregateWindow(
  env: Env,
  tenantId: string,
  startExclusive: string,
  endInclusive: string,
): Promise<AggregateDbRow[]> {
  const { results } = await env.DB.prepare(
    `WITH filtered AS (
       SELECT tenant_id, provider, source, metric, error_kind, ok, signed_error,
              ABS(signed_error) AS absolute_error, id
         FROM measurement_deltas
        WHERE tenant_id = ? AND metric != '' AND signed_error IS NOT NULL
          AND created_at > ? AND created_at <= ?
     ), ranked AS (
       SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY tenant_id, provider, source, metric, error_kind
                ORDER BY absolute_error, id
              ) AS absolute_rank,
              COUNT(*) OVER (
                PARTITION BY tenant_id, provider, source, metric, error_kind
              ) AS cohort_count
         FROM filtered
     )
     SELECT tenant_id, provider, source, metric, error_kind,
            MAX(cohort_count) AS total,
            SUM(ok) AS ok_count,
            SUM(signed_error) AS signed_sum,
            SUM(signed_error * signed_error) AS signed_square_sum,
            AVG(CASE WHEN absolute_rank IN (
              CAST((cohort_count + 1) / 2 AS INTEGER),
              CAST((cohort_count + 2) / 2 AS INTEGER)
            ) THEN absolute_error END) AS median_absolute_error,
            MAX(CASE WHEN absolute_rank = CAST((cohort_count * 50 + 99) / 100 AS INTEGER)
              THEN absolute_error END) AS p50_absolute_error,
            MAX(CASE WHEN absolute_rank = CAST((cohort_count * 90 + 99) / 100 AS INTEGER)
              THEN absolute_error END) AS p90_absolute_error,
            MAX(CASE WHEN absolute_rank = CAST((cohort_count * 95 + 99) / 100 AS INTEGER)
              THEN absolute_error END) AS p95_absolute_error
       FROM ranked
      GROUP BY tenant_id, provider, source, metric, error_kind
      ORDER BY provider, source, metric, error_kind`,
  ).bind(tenantId, startExclusive, endInclusive).all<AggregateDbRow>();
  return results ?? [];
}

function descriptive(row: AggregateDbRow): {
  successRate: number;
  mean: number;
  median: number;
  p50: number;
  p90: number;
  p95: number;
  stddev: number;
  ci: { lower: number; upper: number };
} {
  const mean = row.signed_sum / row.total;
  const variance = Math.max(
    0,
    (row.signed_square_sum - (row.signed_sum * row.signed_sum) / row.total) /
      (row.total - 1),
  );
  const stddev = Math.sqrt(variance);
  const margin = 1.96 * stddev / Math.sqrt(row.total);
  return {
    successRate: rounded(row.ok_count / row.total),
    mean: rounded(mean),
    median: rounded(row.median_absolute_error),
    p50: rounded(row.p50_absolute_error),
    p90: rounded(row.p90_absolute_error),
    p95: rounded(row.p95_absolute_error),
    stddev: rounded(stddev),
    ci: { lower: rounded(mean - margin), upper: rounded(mean + margin) },
  };
}

function isoAt(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export async function measurementCalibrationReport(
  env: Env,
  asOf = new Date(),
): Promise<MeasurementCalibrationReport> {
  const asOfMs = asOf.getTime();
  if (!Number.isFinite(asOfMs)) throw new Error("measurement_calibration_invalid_as_of");
  const tenantId = configuredTenant(env);
  const end = asOf.toISOString();
  const summaryStart = isoAt(asOfMs - MEASUREMENT_CALIBRATION_SUMMARY_DAYS * DAY_MS);
  const currentStart = isoAt(asOfMs - MEASUREMENT_CALIBRATION_DRIFT_DAYS * DAY_MS);
  const previousStart = isoAt(asOfMs - 2 * MEASUREMENT_CALIBRATION_DRIFT_DAYS * DAY_MS);
  const [summary, current, previous] = await Promise.all([
    aggregateWindow(env, tenantId, summaryStart, end),
    aggregateWindow(env, tenantId, currentStart, end),
    aggregateWindow(env, tenantId, previousStart, currentStart),
  ]);
  const currentByCohort = new Map(current.map((row) => [cohortKey(row), row]));
  const previousByCohort = new Map(previous.map((row) => [cohortKey(row), row]));

  const cohorts = summary.map<MeasurementDeltaAggregate>((row) => {
    const enough = row.total >= MEASUREMENT_CALIBRATION_MIN_SAMPLE_SIZE;
    const stats = enough ? descriptive(row) : null;
    const currentRow = currentByCohort.get(cohortKey(row));
    const previousRow = previousByCohort.get(cohortKey(row));
    const driftEnough = !!currentRow && !!previousRow &&
      currentRow.total >= MEASUREMENT_CALIBRATION_MIN_SAMPLE_SIZE &&
      previousRow.total >= MEASUREMENT_CALIBRATION_MIN_SAMPLE_SIZE;
    const currentStats = driftEnough ? descriptive(currentRow) : null;
    const previousStats = driftEnough ? descriptive(previousRow) : null;
    return {
      tenant_id: row.tenant_id,
      provider: row.provider,
      source: row.source,
      metric: row.metric,
      error_kind: row.error_kind,
      total: row.total,
      ok_count: row.ok_count,
      status: enough ? "sufficient_data" : "insufficient_data",
      success_rate: stats?.successRate ?? null,
      mean_signed_bias: stats?.mean ?? null,
      median_absolute_error: stats?.median ?? null,
      p50_absolute_error: stats?.p50 ?? null,
      p90_absolute_error: stats?.p90 ?? null,
      p95_absolute_error: stats?.p95 ?? null,
      sample_stddev: stats?.stddev ?? null,
      mean_signed_bias_ci95: stats?.ci ?? null,
      tolerance_candidate: stats ? {
        status: "approval_required",
        basis: "observed_p95_absolute_error",
        value: stats.p95,
        automatic_promotion: false,
      } : null,
      drift: {
        status: driftEnough ? "sufficient_data" : "insufficient_data",
        current_count: currentRow?.total ?? 0,
        previous_count: previousRow?.total ?? 0,
        mean_signed_bias_delta: currentStats && previousStats
          ? rounded(currentStats.mean - previousStats.mean)
          : null,
        p90_absolute_error_delta: currentStats && previousStats
          ? rounded(currentStats.p90 - previousStats.p90)
          : null,
      },
    };
  });

  return {
    tenant_id: tenantId,
    as_of: end,
    minimum_sample_size: MEASUREMENT_CALIBRATION_MIN_SAMPLE_SIZE,
    automatic_tolerance_promotion: false,
    confidence_interval: {
      level: 0.95,
      method: "normal_approximation_for_mean_signed_error",
      formula: "mean_signed_error +/- 1.96 * sample_stddev / sqrt(n)",
      population: "valid_signed_errors_in_summary_window",
    },
    summary_window: {
      days: MEASUREMENT_CALIBRATION_SUMMARY_DAYS,
      start_exclusive: summaryStart,
      end_inclusive: end,
    },
    drift_windows: {
      days_each: MEASUREMENT_CALIBRATION_DRIFT_DAYS,
      previous: { start_exclusive: previousStart, end_inclusive: currentStart },
      current: { start_exclusive: currentStart, end_inclusive: end },
    },
    cohorts,
  };
}

/** Compatibility projection for callers that only consume the cohort array. */
export async function aggregateMeasurementDeltas(
  env: Env,
  asOf = new Date(),
): Promise<MeasurementDeltaAggregate[]> {
  return (await measurementCalibrationReport(env, asOf)).cohorts;
}

/** Failed comparisons since a cutoff: the tenant-scoped watchdog divergence signal. */
export async function countFailedDeltasSince(env: Env, sinceIso: string): Promise<number> {
  const tenantId = configuredTenant(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM measurement_deltas
      WHERE tenant_id = ? AND ok = 0 AND created_at > ?`,
  ).bind(tenantId, sinceIso).first<{ n: number }>();
  return row?.n ?? 0;
}
