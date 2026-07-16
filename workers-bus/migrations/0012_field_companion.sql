-- 0012_field_companion.sql - durable, resumable field actions and media receipts.
-- The device action id is the idempotency boundary. Media keys are immutable and every
-- correction is a new action; no field endpoint deletes or overwrites an earlier record.

CREATE TABLE IF NOT EXISTS field_actions (
  device_action_id TEXT PRIMARY KEY CHECK (
    length(device_action_id) BETWEEN 8 AND 80
    AND device_action_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 140),
  assignment_id TEXT NOT NULL CHECK (length(assignment_id) BETWEEN 1 AND 140),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('field_checkin')),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'r2_stored', 'frappe_persisted', 'verified', 'retryable_error')
  ),
  checkin_id TEXT NOT NULL CHECK (length(checkin_id) BETWEEN 12 AND 80),
  manifest_key TEXT,
  processing_token TEXT,
  lease_expires_at TEXT,
  response_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  CHECK (status != 'verified' OR (response_json IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_field_actions_job_created
  ON field_actions (tenant_id, job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_field_actions_recovery
  ON field_actions (status, lease_expires_at, updated_at);

CREATE TABLE IF NOT EXISTS field_action_media (
  device_action_id TEXT NOT NULL REFERENCES field_actions(device_action_id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL CHECK (
    length(attachment_id) BETWEEN 1 AND 80
    AND attachment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  evidence_id TEXT NOT NULL CHECK (length(evidence_id) BETWEEN 12 AND 80),
  r2_key TEXT NOT NULL UNIQUE CHECK (length(r2_key) BETWEEN 8 AND 512),
  checksum_sha256 TEXT NOT NULL CHECK (
    length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 3 AND 100),
  content_length INTEGER NOT NULL CHECK (content_length BETWEEN 1 AND 12582912),
  frappe_evidence_name TEXT,
  r2_stored_at TEXT NOT NULL,
  frappe_persisted_at TEXT,
  PRIMARY KEY (device_action_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_field_action_media_evidence
  ON field_action_media (evidence_id);
