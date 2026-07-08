-- 0004_estimate_idempotency.sql - retry-safe public estimator submissions.

ALTER TABLE envelopes ADD COLUMN estimate_submission_key TEXT;
ALTER TABLE envelopes ADD COLUMN erpnext_instant_estimate_session_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_env_estimate_submission_key
  ON envelopes (estimate_submission_key);
CREATE INDEX IF NOT EXISTS idx_env_erpnext_instant_estimate
  ON envelopes (erpnext_instant_estimate_session_id);
