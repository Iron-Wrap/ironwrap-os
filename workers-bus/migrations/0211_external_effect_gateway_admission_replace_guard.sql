-- 0211_external_effect_gateway_admission_replace_guard.sql
-- SQLite REPLACE may omit DELETE triggers when recursive_triggers is off. Logical ID
-- collisions are refused before conflict handling; physical collisions abort the complete
-- insert statement through the cardinality witness, preserving the prior evidence.
-- The UPDATE/DELETE guards from 0210 stay unchanged. Fresh admission IDs still append.
-- The logical guard runs before conflict handling, including INSERT OR IGNORE.
-- A derived count below also detects physical-row replacement after SQLite allocates row IDs.
CREATE TRIGGER IF NOT EXISTS external_effect_gateway_admissions_no_replace
BEFORE INSERT ON external_effect_gateway_admissions
WHEN EXISTS (
  SELECT 1 FROM external_effect_gateway_admissions WHERE admission_id = NEW.admission_id
)
BEGIN
  SELECT RAISE(ABORT, 'external_effect_gateway_admissions_append_only');
END;

-- A derived cardinality witness survives dump/restore without depending on hidden row IDs.
CREATE TABLE IF NOT EXISTS external_effect_gateway_admission_count (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  row_count INTEGER NOT NULL CHECK (typeof(row_count) = 'integer' AND row_count >= 0)
);
INSERT INTO external_effect_gateway_admission_count (singleton, row_count)
SELECT 1, COUNT(*) FROM external_effect_gateway_admissions;

CREATE TRIGGER IF NOT EXISTS external_effect_gateway_admission_count_no_replace
BEFORE INSERT ON external_effect_gateway_admission_count
WHEN EXISTS (SELECT 1 FROM external_effect_gateway_admission_count)
BEGIN
  SELECT RAISE(ABORT, 'external_effect_gateway_admissions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS external_effect_gateway_admission_count_update_guard
BEFORE UPDATE ON external_effect_gateway_admission_count
WHEN NEW.singleton IS NOT OLD.singleton
  OR NEW.row_count IS NOT (OLD.row_count + 1)
  OR NEW.row_count IS NOT (SELECT COUNT(*) FROM external_effect_gateway_admissions)
BEGIN
  SELECT RAISE(ABORT, 'external_effect_gateway_admissions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS external_effect_gateway_admission_count_no_delete
BEFORE DELETE ON external_effect_gateway_admission_count
BEGIN
  SELECT RAISE(ABORT, 'external_effect_gateway_admissions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS external_effect_gateway_admissions_append_count
AFTER INSERT ON external_effect_gateway_admissions
BEGIN
  SELECT RAISE(ABORT, 'external_effect_gateway_admissions_append_only')
  WHERE NOT EXISTS (
    SELECT 1 FROM external_effect_gateway_admission_count
    WHERE singleton = 1
      AND row_count = (SELECT COUNT(*) - 1 FROM external_effect_gateway_admissions)
  );
  UPDATE external_effect_gateway_admission_count SET row_count = row_count + 1 WHERE singleton = 1;
END;
