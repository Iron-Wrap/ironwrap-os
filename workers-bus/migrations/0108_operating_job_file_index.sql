-- 0108_operating_job_file_index.sql
-- IRO-48: one append-only index of job-file pointers (Drive / R2) keyed to
-- operating_roof_jobs. Does not send files to customers or suppliers.

CREATE TABLE IF NOT EXISTS operating_job_file_index (
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  roof_job_id TEXT NOT NULL CHECK (
    length(roof_job_id) BETWEEN 8 AND 200
    AND roof_job_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN (
      'facet_design', 'measurement', 'photo', 'proposal', 'check_in', 'archive'
    )
  ),
  artifact_id TEXT NOT NULL CHECK (
    length(artifact_id) BETWEEN 8 AND 200
    AND artifact_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  drive_folder_id TEXT CHECK (
    drive_folder_id IS NULL OR length(trim(drive_folder_id)) BETWEEN 8 AND 128
  ),
  drive_file_id TEXT CHECK (
    drive_file_id IS NULL OR length(trim(drive_file_id)) BETWEEN 8 AND 128
  ),
  r2_key TEXT CHECK (
    r2_key IS NULL OR length(trim(r2_key)) BETWEEN 8 AND 512
  ),
  content_sha256 TEXT CHECK (
    content_sha256 IS NULL OR (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  idempotency_key TEXT CHECK (
    idempotency_key IS NULL OR length(trim(idempotency_key)) BETWEEN 8 AND 160
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  CHECK (drive_file_id IS NOT NULL OR r2_key IS NOT NULL),
  PRIMARY KEY (tenant_id, artifact_kind, artifact_id),
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_job_file_index_job
  ON operating_job_file_index (tenant_id, roof_job_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operating_job_file_index_idempotency
  ON operating_job_file_index (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER operating_job_file_index_append_only_update
BEFORE UPDATE ON operating_job_file_index
BEGIN
  SELECT RAISE(ABORT, 'operating_job_file_index_append_only');
END;

CREATE TRIGGER operating_job_file_index_append_only_delete
BEFORE DELETE ON operating_job_file_index
BEGIN
  SELECT RAISE(ABORT, 'operating_job_file_index_append_only');
END;
