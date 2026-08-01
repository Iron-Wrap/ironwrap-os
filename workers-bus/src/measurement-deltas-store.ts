// measurement-deltas-store.ts - append-only calibration ledger (migration 0033).
//
// Every intake-time verification comparison lands here as one queryable row:
// primary source vs an independent source with the numeric delta, plus
// informational evidence rows (coverage, imagery age). Over jobs this becomes
// the measured accuracy distribution per provider/source - the dataset that
// turns tolerance bands and shadow-run exit criteria from guesses into
// measurements. INSERT OR IGNORE + the (receipt, check, metric) unique key make
// intake retries idempotent; a missing table (pre-0033 database) must never
// fail intake, so writers catch upstream.

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
  created_at: string;
}

export interface MeasurementDeltaAggregate {
  source: string;
  metric: string;
  total: number;
  ok_count: number;
  avg_rel_diff: number | null;
  max_rel_diff: number | null;
  avg_abs_diff: number | null;
  max_abs_diff: number | null;
}

export async function recordMeasurementDeltas(env: Env, rows: MeasurementDeltaRow[]): Promise<void> {
  const now = new Date().toISOString();
  for (const row of rows) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO measurement_deltas
         (receipt_id, measurement_id, job_number, provider, source, check_name, metric,
          ok, primary_value, independent_value, rel_diff, abs_diff, detail, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      row.receipt_id, row.measurement_id, row.job_number, row.provider, row.source,
      row.check_name, row.metric, row.ok ? 1 : 0, row.primary_value, row.independent_value,
      row.rel_diff, row.abs_diff, row.detail, now,
    ).run();
  }
}

export async function listMeasurementDeltas(env: Env, limit: number): Promise<MeasurementDeltaRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, receipt_id, measurement_id, job_number, provider, source, check_name, metric,
            ok, primary_value, independent_value, rel_diff, abs_diff, detail, created_at
       FROM measurement_deltas ORDER BY id DESC LIMIT ?`,
  ).bind(limit).all<Omit<MeasurementDeltaRecord, "ok"> & { ok: number }>();
  return (results ?? []).map((r) => ({ ...r, ok: !!r.ok }));
}

/** Measured accuracy per (source, metric) over every numeric comparison recorded. */
export async function aggregateMeasurementDeltas(env: Env): Promise<MeasurementDeltaAggregate[]> {
  const { results } = await env.DB.prepare(
    `SELECT source, metric,
            COUNT(*) AS total,
            SUM(ok) AS ok_count,
            AVG(ABS(rel_diff)) AS avg_rel_diff,
            MAX(ABS(rel_diff)) AS max_rel_diff,
            AVG(ABS(abs_diff)) AS avg_abs_diff,
            MAX(ABS(abs_diff)) AS max_abs_diff
       FROM measurement_deltas
      WHERE metric != ''
      GROUP BY source, metric
      ORDER BY source, metric`,
  ).bind().all<MeasurementDeltaAggregate>();
  return results ?? [];
}

/** Failed comparisons since a cutoff: the watchdog's divergence signal. */
export async function countFailedDeltasSince(env: Env, sinceIso: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM measurement_deltas WHERE ok = 0 AND created_at > ?`,
  ).bind(sinceIso).first<{ n: number }>();
  return row?.n ?? 0;
}
