-- Make calibration evidence tenant-bound, signed, and immutable. Existing 0033
-- rows belong to the original IronWrap tenant and are deterministically
-- backfilled from their preserved primary/independent source values.
ALTER TABLE measurement_deltas
  ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'ironwrap'
  CHECK (length(tenant_id) BETWEEN 1 AND 64);

ALTER TABLE measurement_deltas
  ADD COLUMN error_kind TEXT NOT NULL DEFAULT ''
  CHECK (error_kind IN ('', 'relative_fraction', 'absolute_unit'));

ALTER TABLE measurement_deltas
  ADD COLUMN signed_error REAL
  CHECK (signed_error IS NULL OR typeof(signed_error) IN ('integer', 'real'));

UPDATE measurement_deltas
   SET error_kind = CASE
         WHEN rel_diff IS NOT NULL
          AND abs_diff IS NULL
          AND typeof(primary_value) IN ('integer', 'real')
          AND typeof(independent_value) IN ('integer', 'real')
          AND typeof(rel_diff) IN ('integer', 'real')
          AND primary_value != 0
          AND rel_diff >= 0
          AND ABS(ABS((independent_value - primary_value) / primary_value) - rel_diff) <= 0.000001
           THEN 'relative_fraction'
         WHEN abs_diff IS NOT NULL
          AND rel_diff IS NULL
          AND typeof(primary_value) IN ('integer', 'real')
          AND typeof(independent_value) IN ('integer', 'real')
          AND typeof(abs_diff) IN ('integer', 'real')
          AND abs_diff >= 0
          AND ABS(ABS(independent_value - primary_value) - abs_diff) <= 0.0001
           THEN 'absolute_unit'
         ELSE ''
       END,
       signed_error = CASE
         WHEN rel_diff IS NOT NULL
          AND abs_diff IS NULL
          AND typeof(primary_value) IN ('integer', 'real')
          AND typeof(independent_value) IN ('integer', 'real')
          AND typeof(rel_diff) IN ('integer', 'real')
          AND primary_value != 0
          AND rel_diff >= 0
          AND ABS(ABS((independent_value - primary_value) / primary_value) - rel_diff) <= 0.000001
           THEN ROUND((independent_value - primary_value) / primary_value, 6)
         WHEN abs_diff IS NOT NULL
          AND rel_diff IS NULL
          AND typeof(primary_value) IN ('integer', 'real')
          AND typeof(independent_value) IN ('integer', 'real')
          AND typeof(abs_diff) IN ('integer', 'real')
          AND abs_diff >= 0
          AND ABS(ABS(independent_value - primary_value) - abs_diff) <= 0.0001
           THEN ROUND(independent_value - primary_value, 4)
         ELSE NULL
       END;

-- The 0033 identity was global. Recreate it with tenant_id so identical
-- provider receipts in isolated tenants do not collide or expose one another.
DROP INDEX idx_measurement_deltas_identity;
CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_deltas_identity
  ON measurement_deltas (tenant_id, receipt_id, check_name, metric);

CREATE INDEX IF NOT EXISTS idx_measurement_deltas_tenant_cohort_created
  ON measurement_deltas
    (tenant_id, provider, source, metric, error_kind, created_at, id);

CREATE TRIGGER IF NOT EXISTS measurement_deltas_append_only_update
BEFORE UPDATE ON measurement_deltas
BEGIN
  SELECT RAISE(ABORT, 'measurement_deltas_append_only');
END;

CREATE TRIGGER IF NOT EXISTS measurement_deltas_append_only_delete
BEFORE DELETE ON measurement_deltas
BEGIN
  SELECT RAISE(ABORT, 'measurement_deltas_append_only');
END;
