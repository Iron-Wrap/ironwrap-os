-- 0211_external_effect_gateway_admission_replace_guard.sql
-- SQLite REPLACE may omit DELETE triggers when recursive_triggers is off. Refuse any
-- INSERT that collides with an existing admission before conflict handling can evict it.
-- The UPDATE/DELETE guards from 0210 stay unchanged. Fresh admission IDs still append.
-- One additional trigger; no table/index/column changes.
CREATE TRIGGER IF NOT EXISTS external_effect_gateway_admissions_no_replace
BEFORE INSERT ON external_effect_gateway_admissions
WHEN EXISTS (
  SELECT 1 FROM external_effect_gateway_admissions WHERE admission_id = NEW.admission_id
)
BEGIN
  SELECT RAISE(ABORT, 'external_effect_gateway_admissions_append_only');
END;
