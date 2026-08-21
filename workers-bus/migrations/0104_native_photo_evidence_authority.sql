-- 0104_native_photo_evidence_authority.sql - native jobsite photo evidence authority.
--
-- Raw ingest remains an immutable R2 object. This ledger binds the exact payload hash and each
-- photo/voice URI to one tenant-scoped operating job (or an explicit unmatched disposition).
-- ERPNext/Frappe is neither a source nor a write destination on this path.

CREATE TABLE IF NOT EXISTS native_photo_evidence_submissions (
  submission_id TEXT PRIMARY KEY CHECK (
    length(submission_id) = 69
    AND submission_id GLOB 'psub_[0-9a-f]*'
    AND substr(submission_id, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  envelope_id TEXT NOT NULL CHECK (
    length(envelope_id) BETWEEN 8 AND 64
    AND envelope_id GLOB 'ow_*'
  ),
  job_number TEXT NOT NULL CHECK (length(job_number) BETWEEN 1 AND 160),
  roof_job_id TEXT CHECK (
    roof_job_id IS NULL OR length(roof_job_id) BETWEEN 8 AND 200
  ),
  operating_job_version INTEGER CHECK (
    operating_job_version IS NULL OR operating_job_version BETWEEN 1 AND 1000000
  ),
  association_status TEXT NOT NULL CHECK (association_status IN ('matched', 'unmatched')),
  association_error TEXT CHECK (
    association_error IS NULL OR length(association_error) BETWEEN 3 AND 120
  ),
  raw_key TEXT NOT NULL CHECK (
    raw_key GLOB 'raw/photos/*'
    AND length(raw_key) BETWEEN 24 AND 280
  ),
  raw_sha256 TEXT NOT NULL CHECK (
    length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  caption TEXT CHECK (caption IS NULL OR length(trim(caption)) BETWEEN 1 AND 2000),
  captured_at TEXT NOT NULL CHECK (length(captured_at) BETWEEN 20 AND 40),
  photo_count INTEGER NOT NULL CHECK (photo_count BETWEEN 1 AND 120),
  drive_folder_url TEXT CHECK (
    drive_folder_url IS NULL OR length(drive_folder_url) BETWEEN 8 AND 2000
  ),
  projection_json TEXT NOT NULL CHECK (
    length(projection_json) BETWEEN 2 AND 2097152 AND json_valid(projection_json)
  ),
  projection_sha256 TEXT NOT NULL CHECK (
    length(projection_sha256) = 64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (submission_id, tenant_id),
  CHECK (
    (association_status = 'matched'
      AND roof_job_id IS NOT NULL
      AND operating_job_version IS NOT NULL
      AND association_error IS NULL)
    OR
    (association_status = 'unmatched'
      AND roof_job_id IS NULL
      AND operating_job_version IS NULL
      AND association_error IS NOT NULL)
  ),
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_native_photo_evidence_submissions_envelope
  ON native_photo_evidence_submissions (tenant_id, envelope_id);
CREATE INDEX IF NOT EXISTS idx_native_photo_evidence_submissions_job
  ON native_photo_evidence_submissions (tenant_id, job_number, created_at DESC);

CREATE TABLE IF NOT EXISTS native_photo_evidence_items (
  evidence_id TEXT PRIMARY KEY CHECK (
    length(evidence_id) = 69
    AND evidence_id GLOB 'pevi_[0-9a-f]*'
    AND substr(evidence_id, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  submission_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  item_index INTEGER NOT NULL CHECK (item_index BETWEEN 0 AND 119),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('photo', 'voice_note')),
  source_uri TEXT NOT NULL CHECK (length(source_uri) BETWEEN 8 AND 2000),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 240),
  drive_file_url TEXT CHECK (
    drive_file_url IS NULL OR length(drive_file_url) BETWEEN 8 AND 2000
  ),
  drive_file_id TEXT CHECK (
    drive_file_id IS NULL OR length(drive_file_id) BETWEEN 1 AND 200
  ),
  fetch_error TEXT CHECK (
    fetch_error IS NULL OR length(fetch_error) BETWEEN 1 AND 240
  ),
  UNIQUE (evidence_id, tenant_id),
  FOREIGN KEY (submission_id, tenant_id)
    REFERENCES native_photo_evidence_submissions(submission_id, tenant_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_native_photo_evidence_items_submission
  ON native_photo_evidence_items (submission_id, item_index);

CREATE TRIGGER IF NOT EXISTS native_photo_evidence_submissions_job_guard
BEFORE INSERT ON native_photo_evidence_submissions
WHEN NEW.association_status = 'matched' AND NOT EXISTS (
  SELECT 1
    FROM operating_roof_jobs AS job
   WHERE job.tenant_id = NEW.tenant_id
     AND job.roof_job_id = NEW.roof_job_id
     AND job.job_number = NEW.job_number
     AND job.version = NEW.operating_job_version
)
BEGIN SELECT RAISE(ABORT, 'native_photo_job_anchor_mismatch'); END;

CREATE TRIGGER IF NOT EXISTS native_photo_evidence_submissions_no_insert_replace
BEFORE INSERT ON native_photo_evidence_submissions
WHEN EXISTS (
  SELECT 1
    FROM native_photo_evidence_submissions AS existing
   WHERE existing.submission_id = NEW.submission_id
      OR (existing.tenant_id = NEW.tenant_id AND existing.envelope_id = NEW.envelope_id)
)
BEGIN SELECT RAISE(ABORT, 'native_photo_insert_replace_forbidden'); END;

CREATE TRIGGER IF NOT EXISTS native_photo_evidence_submissions_append_only_update
BEFORE UPDATE ON native_photo_evidence_submissions
BEGIN SELECT RAISE(ABORT, 'native_photo_evidence_submissions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS native_photo_evidence_submissions_append_only_delete
BEFORE DELETE ON native_photo_evidence_submissions
BEGIN SELECT RAISE(ABORT, 'native_photo_evidence_submissions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS native_photo_evidence_items_parent_guard
BEFORE INSERT ON native_photo_evidence_items
WHEN NOT EXISTS (
  SELECT 1
    FROM native_photo_evidence_submissions AS submission
   WHERE submission.submission_id = NEW.submission_id
     AND submission.tenant_id = NEW.tenant_id
     AND NEW.item_index < submission.photo_count
)
BEGIN SELECT RAISE(ABORT, 'native_photo_item_parent_mismatch'); END;

CREATE TRIGGER IF NOT EXISTS native_photo_evidence_items_no_insert_replace
BEFORE INSERT ON native_photo_evidence_items
WHEN EXISTS (
  SELECT 1
    FROM native_photo_evidence_items AS existing
   WHERE existing.evidence_id = NEW.evidence_id
      OR (existing.submission_id = NEW.submission_id AND existing.item_index = NEW.item_index)
)
BEGIN SELECT RAISE(ABORT, 'native_photo_item_insert_replace_forbidden'); END;

CREATE TRIGGER IF NOT EXISTS native_photo_evidence_items_append_only_update
BEFORE UPDATE ON native_photo_evidence_items
BEGIN SELECT RAISE(ABORT, 'native_photo_evidence_items_append_only'); END;

CREATE TRIGGER IF NOT EXISTS native_photo_evidence_items_append_only_delete
BEFORE DELETE ON native_photo_evidence_items
BEGIN SELECT RAISE(ABORT, 'native_photo_evidence_items_append_only'); END;
