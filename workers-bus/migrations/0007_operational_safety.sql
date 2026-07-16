-- 0007_operational_safety.sql - status/replay indexes and source-count invariants.

CREATE INDEX IF NOT EXISTS idx_dead_letter_open_envelope
  ON dead_letter (recovered, envelope_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_result_ts
  ON audit_log (result, ts);
CREATE INDEX IF NOT EXISTS idx_envelopes_operational
  ON envelopes (status, updated_at, erpnext_error);
CREATE INDEX IF NOT EXISTS idx_heartbeat_ran_at
  ON heartbeat (ran_at);
CREATE INDEX IF NOT EXISTS idx_qb_receipts_last_seen
  ON quickbooks_webhook_receipts (last_seen_at);

-- Defense in depth: the Worker validates the same contract before writing.
CREATE TRIGGER IF NOT EXISTS validate_source_count_insert
BEFORE INSERT ON source_counts
WHEN
  NEW.day NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR date(NEW.day, '+0 days') IS NULL
  OR date(NEW.day, '+0 days') != NEW.day
  OR NEW.channel NOT IN ('website','phone','gbp','ad','referral','manual')
  OR typeof(NEW.count) != 'integer'
  OR NEW.count < 0
  OR NEW.count > 1000000
BEGIN
  SELECT RAISE(ABORT, 'invalid_source_count');
END;

CREATE TRIGGER IF NOT EXISTS validate_source_count_update
BEFORE UPDATE ON source_counts
WHEN
  NEW.day NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR date(NEW.day, '+0 days') IS NULL
  OR date(NEW.day, '+0 days') != NEW.day
  OR NEW.channel NOT IN ('website','phone','gbp','ad','referral','manual')
  OR typeof(NEW.count) != 'integer'
  OR NEW.count < 0
  OR NEW.count > 1000000
BEGIN
  SELECT RAISE(ABORT, 'invalid_source_count');
END;
