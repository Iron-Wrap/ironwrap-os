-- 0008_operational_safety_hardening.sql - safe follow-up if 0007 was already applied.

-- The status query counts unresolved Frappe errors independently from pending JobNimbus work.
-- A partial index keeps that production diagnostic proportional to the unresolved set.
CREATE INDEX IF NOT EXISTS idx_envelopes_erpnext_error_open
  ON envelopes (updated_at)
  WHERE erpnext_error IS NOT NULL AND trim(erpnext_error) != '';

-- Triggers added in 0007 protect new writes. Touch existing rows once so migration application
-- also fails closed if legacy data violates the same day/channel/count contract.
UPDATE source_counts SET count = count;
