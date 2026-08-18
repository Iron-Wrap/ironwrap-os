import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  listMeasurementDeltas,
  measurementCalibrationReport,
  recordMeasurementDeltas,
  type MeasurementDeltaRow,
} from "../src/measurement-deltas-store.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor(applyCalibration = true) {
    const migrations = ["0033_measurement_deltas.sql"];
    if (applyCalibration) migrations.push("0037_measurement_calibration.sql");
    for (const migration of migrations)
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }

  applyCalibrationMigration(): void {
    this.raw.exec(readFileSync(
      new URL("../migrations/0037_measurement_calibration.sql", import.meta.url),
      "utf8",
    ));
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => (this.raw.prepare(sql).get(...args) ?? null) as T | null,
        all: async <T>() => ({ results: this.raw.prepare(sql).all(...args) as T[] }),
        run: async () => {
          const result = this.raw.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(result.changes ?? 0) } };
        },
      }),
    };
  }
}

function env(db: SqliteD1, tenant = "ironwrap"): Env {
  return { DB: db as never, APP_TENANT_ID: tenant } as unknown as Env;
}

function relativeRow(
  id: string,
  signedError: number,
  ok: boolean,
  metric = "roof_area",
): MeasurementDeltaRow {
  const primary = 100;
  return {
    receipt_id: `receipt-${id}`,
    measurement_id: `measurement-${id}`,
    job_number: null,
    provider: "applicad",
    source: "google_solar",
    check_name: `cross_source_${metric}`,
    metric,
    ok,
    primary_value: primary,
    independent_value: primary * (1 + signedError),
    rel_diff: Math.abs(signedError),
    abs_diff: null,
    detail: `synthetic calibration evidence ${id}`,
  };
}

test("measurement calibration rejects invalid evidence and conflicting replay", async () => {
  const db = new SqliteD1();
  const ironwrap = env(db);
  const row = relativeRow("immutable", -0.1, true);

  await assert.rejects(
    recordMeasurementDeltas(ironwrap, [{ ...row, primary_value: Number.POSITIVE_INFINITY }]),
    /measurement_delta_nonfinite/,
  );
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM measurement_deltas").get()!.n, 0);

  await recordMeasurementDeltas(ironwrap, [row], new Date("2026-07-01T00:00:00.000Z"));
  await recordMeasurementDeltas(ironwrap, [row], new Date("2026-07-02T00:00:00.000Z"));
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM measurement_deltas").get()!.n, 1);
  await assert.rejects(
    recordMeasurementDeltas(ironwrap, [{ ...row, detail: "conflicting replay" }]),
    /measurement_delta_immutable_conflict/,
  );

  assert.throws(
    () => db.raw.prepare("UPDATE measurement_deltas SET ok = 0").run(),
    /measurement_deltas_append_only/,
  );
  assert.throws(
    () => db.raw.prepare("DELETE FROM measurement_deltas").run(),
    /measurement_deltas_append_only/,
  );
});

test("measurement calibration isolates tenant reads and declares insufficient data", async () => {
  const db = new SqliteD1();
  const observedAt = new Date("2026-08-01T00:00:00.000Z");
  const sharedIdentity = relativeRow("shared", 0.01, true);
  await recordMeasurementDeltas(env(db), [sharedIdentity], observedAt);
  await recordMeasurementDeltas(env(db, "iroof"), [sharedIdentity], observedAt);

  const ironwrapRows = await listMeasurementDeltas(env(db), 50);
  const iroofRows = await listMeasurementDeltas(env(db, "iroof"), 50);
  assert.deepEqual(ironwrapRows.map((row) => row.tenant_id), ["ironwrap"]);
  assert.deepEqual(iroofRows.map((row) => row.tenant_id), ["iroof"]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM measurement_deltas").get()!.n, 2);

  await assert.rejects(
    recordMeasurementDeltas(env(db, "iroof"), [{ ...sharedIdentity, detail: "other tenant conflict" }]),
    /measurement_delta_immutable_conflict/,
  );
  assert.equal((await listMeasurementDeltas(env(db), 50))[0].detail, sharedIdentity.detail);

  const report = await measurementCalibrationReport(env(db), new Date("2026-08-13T00:00:00.000Z"));
  assert.equal(report.cohorts[0].status, "insufficient_data");
  assert.equal(report.cohorts[0].success_rate, null);
  assert.equal(report.cohorts[0].tolerance_candidate, null);
  assert.equal(report.automatic_tolerance_promotion, false);
});

test("0037 backfills only valid historical comparisons and quarantines ambiguous evidence", async () => {
  const db = new SqliteD1(false);
  const insert = db.raw.prepare(
    `INSERT INTO measurement_deltas
       (receipt_id, measurement_id, provider, source, check_name, metric, ok,
        primary_value, independent_value, rel_diff, abs_diff, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    "legacy-incomplete", "measurement-legacy", "applicad", "google_solar",
    "cross_source_roof_area", "roof_area", 0, null, 120, 0.2, null,
    "legacy row missing its primary value", "2026-08-01T00:00:00.000Z",
  );
  insert.run(
    "legacy-ambiguous", "measurement-legacy", "applicad", "google_solar",
    "cross_source-roof_area_ambiguous", "roof_area", 0, 100, 120, 0.2, 20,
    "legacy row with both error representations", "2026-08-01T00:00:00.000Z",
  );
  insert.run(
    "legacy-valid", "measurement-legacy", "applicad", "google_solar",
    "cross_source-roof_area_valid", "roof_area", 1, 100, 110, 0.1, null,
    "legacy row with one consistent error representation", "2026-08-01T00:00:00.000Z",
  );
  db.applyCalibrationMigration();

  const stored = db.raw.prepare(
    "SELECT receipt_id, tenant_id, error_kind, signed_error FROM measurement_deltas ORDER BY receipt_id",
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(stored, [
    { receipt_id: "legacy-ambiguous", tenant_id: "ironwrap", error_kind: "", signed_error: null },
    { receipt_id: "legacy-incomplete", tenant_id: "ironwrap", error_kind: "", signed_error: null },
    { receipt_id: "legacy-valid", tenant_id: "ironwrap", error_kind: "relative_fraction", signed_error: 0.1 },
  ]);
  const report = await measurementCalibrationReport(
    env(db),
    new Date("2026-08-13T00:00:00.000Z"),
  );
  assert.equal(report.cohorts.length, 1);
  assert.equal(report.cohorts[0].total, 1);
  assert.equal(report.cohorts[0].status, "insufficient_data");
});

test("measurement calibration computes deterministic distributions and equal-window drift", async () => {
  const db = new SqliteD1();
  const ironwrap = env(db);
  const previous = Array.from({ length: 30 }, (_, index) =>
    relativeRow(`previous-${index}`, -0.1, true));
  const current = Array.from({ length: 30 }, (_, index) =>
    relativeRow(`current-${index}`, 0.2, false));

  await recordMeasurementDeltas(ironwrap, previous, new Date("2026-06-29T00:00:00.000Z"));
  await recordMeasurementDeltas(ironwrap, current, new Date("2026-07-29T00:00:00.000Z"));

  const report = await measurementCalibrationReport(
    ironwrap,
    new Date("2026-08-13T00:00:00.000Z"),
  );
  assert.equal(report.confidence_interval.method, "normal_approximation_for_mean_signed_error");
  assert.equal(
    report.confidence_interval.formula,
    "mean_signed_error +/- 1.96 * sample_stddev / sqrt(n)",
  );
  assert.equal(report.confidence_interval.population, "valid_signed_errors_in_summary_window");
  assert.equal(report.minimum_sample_size, 30);
  assert.equal(report.cohorts.length, 1);
  const cohort = report.cohorts[0];
  assert.equal(cohort.status, "sufficient_data");
  assert.equal(cohort.total, 60);
  assert.equal(cohort.ok_count, 30);
  assert.equal(cohort.success_rate, 0.5);
  assert.equal(cohort.mean_signed_bias, 0.05);
  assert.equal(cohort.median_absolute_error, 0.15);
  assert.equal(cohort.p50_absolute_error, 0.1);
  assert.equal(cohort.p90_absolute_error, 0.2);
  assert.equal(cohort.p95_absolute_error, 0.2);
  assert.ok((cohort.sample_stddev ?? 0) > 0.15);
  assert.ok((cohort.mean_signed_bias_ci95?.lower ?? 1) < 0.05);
  assert.ok((cohort.mean_signed_bias_ci95?.upper ?? -1) > 0.05);
  assert.deepEqual(cohort.tolerance_candidate, {
    status: "approval_required",
    basis: "observed_p95_absolute_error",
    value: 0.2,
    automatic_promotion: false,
  });
  assert.deepEqual(cohort.drift, {
    status: "sufficient_data",
    current_count: 30,
    previous_count: 30,
    mean_signed_bias_delta: 0.3,
    p90_absolute_error_delta: 0.1,
  });
});
