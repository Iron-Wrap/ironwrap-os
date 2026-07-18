-- 0023_newo_caller_association.sql - verified caller-to-owned-record association.

ALTER TABLE newo_sessions ADD COLUMN matched_customer_id TEXT;
ALTER TABLE newo_sessions ADD COLUMN matched_property_id TEXT;
ALTER TABLE newo_sessions ADD COLUMN matched_roof_job_id TEXT;
ALTER TABLE newo_sessions ADD COLUMN verification_status TEXT;

CREATE INDEX IF NOT EXISTS idx_newo_sessions_verified_job
  ON newo_sessions (verification_status, matched_roof_job_id, updated_at);
