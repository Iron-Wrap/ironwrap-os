-- Durable receipts for bounded field work-package commands. These are not a
-- generic Frappe write queue: every command is scoped by the BFF and then
-- independently revalidated by the Frappe service method.

CREATE TABLE IF NOT EXISTS field_work_package_actions (
  device_action_id TEXT PRIMARY KEY CHECK (
    length(device_action_id) BETWEEN 8 AND 80
    AND device_action_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 120),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 140),
  job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 140),
  assignment_id TEXT NOT NULL CHECK (length(assignment_id) BETWEEN 1 AND 140),
  work_package_id TEXT NOT NULL CHECK (
    length(work_package_id) BETWEEN 1 AND 140
    AND work_package_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('acknowledge', 'stop_work', 'start_work')),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('processing', 'r2_stored', 'verified', 'retryable_error')),
  manifest_key TEXT,
  processing_token TEXT,
  lease_expires_at TEXT,
  response_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  CHECK (
    (status = 'verified' AND response_json IS NOT NULL AND verified_at IS NOT NULL)
    OR (status != 'verified' AND verified_at IS NULL)
  ),
  FOREIGN KEY (user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_field_work_package_actions_job_created
  ON field_work_package_actions (tenant_id, job_id, created_at DESC, device_action_id DESC);

CREATE INDEX IF NOT EXISTS idx_field_work_package_actions_recovery
  ON field_work_package_actions (status, lease_expires_at, updated_at)
  WHERE status IN ('processing', 'r2_stored', 'retryable_error');
