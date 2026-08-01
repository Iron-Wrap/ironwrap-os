-- Measurement delta ledger: one append-only row per verification comparison at
-- intake time (primary source vs an independent source, plus informational
-- coverage/imagery evidence). This is the calibration dataset: measured accuracy
-- by provider/source over time, the input for tolerance reviews and the
-- shadow-run exit criteria. UNIQUE key makes intake retries idempotent.
CREATE TABLE IF NOT EXISTS measurement_deltas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL,
  measurement_id TEXT NOT NULL,
  job_number TEXT,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  check_name TEXT NOT NULL,
  -- '' for informational rows (coverage, imagery); metric name for numeric ones.
  metric TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL,
  primary_value REAL,
  independent_value REAL,
  rel_diff REAL,
  abs_diff REAL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_deltas_identity
  ON measurement_deltas (receipt_id, check_name, metric);
CREATE INDEX IF NOT EXISTS idx_measurement_deltas_created
  ON measurement_deltas (created_at);
CREATE INDEX IF NOT EXISTS idx_measurement_deltas_metric
  ON measurement_deltas (metric, ok);
