-- 0057_work_package_completion_action_kind.sql - forward remediation for the
-- edit made to the already-shipped 0028_work_package_actions.sql in the #52
-- assembly (Linear IRO-62 hazard 2, project rule 4).
--
-- Production applied the ORIGINAL 0028 on 2026-08-13 and wrangler keys applied
-- migrations by filename, so the widened action_kind CHECK added by the edit is
-- never applied there: every complete_work receipt insert would abort with a
-- CHECK violation. 0028 is restored to its shipped bytes in the same change and
-- the widening is delivered here instead, so a database that already applied
-- 0028 and a database built from a clean chain converge on the same table.
--
-- SQLite cannot alter a CHECK in place, so the constraint is widened by a
-- copy-preserving rebuild that ends at exactly the table, index and constraint
-- text 0028 produces plus the complete_work member.
--
-- Bounded and reversible-by-inspection: one staging table, one full copy back,
-- both indexes recreated verbatim under their original names. No trigger exists
-- on this table and no other table references it. Row counts and index names are
-- preserved, so the D1 backup and restore inventories in deploy/ stay green.
--
-- Numbering: the plan on Linear IRO-62 reserved 0055, but PR #53 has since
-- renumbered its migration to 0056, so 0057 is the first number above every
-- filename on main and on every open PR head (project rule 4).

CREATE TABLE _mig0057_field_work_package_actions_staging (
  device_action_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_key TEXT,
  processing_token TEXT,
  lease_expires_at TEXT,
  response_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT
);

INSERT INTO _mig0057_field_work_package_actions_staging (
  device_action_id, tenant_id, user_id, job_id, assignment_id, work_package_id,
  action_kind, payload_hash, status, manifest_key, processing_token,
  lease_expires_at, response_json, last_error, created_at, updated_at, verified_at
)
SELECT
  device_action_id, tenant_id, user_id, job_id, assignment_id, work_package_id,
  action_kind, payload_hash, status, manifest_key, processing_token,
  lease_expires_at, response_json, last_error, created_at, updated_at, verified_at
FROM field_work_package_actions;

DROP TABLE field_work_package_actions;

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
  action_kind TEXT NOT NULL CHECK (action_kind IN ('acknowledge', 'stop_work', 'start_work', 'complete_work')),
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

INSERT INTO field_work_package_actions (
  device_action_id, tenant_id, user_id, job_id, assignment_id, work_package_id,
  action_kind, payload_hash, status, manifest_key, processing_token,
  lease_expires_at, response_json, last_error, created_at, updated_at, verified_at
)
SELECT
  device_action_id, tenant_id, user_id, job_id, assignment_id, work_package_id,
  action_kind, payload_hash, status, manifest_key, processing_token,
  lease_expires_at, response_json, last_error, created_at, updated_at, verified_at
FROM _mig0057_field_work_package_actions_staging;

DROP TABLE _mig0057_field_work_package_actions_staging;

CREATE INDEX IF NOT EXISTS idx_field_work_package_actions_job_created
  ON field_work_package_actions (tenant_id, job_id, created_at DESC, device_action_id DESC);

CREATE INDEX IF NOT EXISTS idx_field_work_package_actions_recovery
  ON field_work_package_actions (status, lease_expires_at, updated_at)
  WHERE status IN ('processing', 'r2_stored', 'retryable_error');
