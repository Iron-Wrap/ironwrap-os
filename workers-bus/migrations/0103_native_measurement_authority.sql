-- 0103_native_measurement_authority.sql - native measurement evidence and association authority.
--
-- Raw intake, fetched reports, and OCR evidence remain immutable R2 objects. This ledger binds
-- their exact hashes to one tenant-scoped operating job (or an explicit unmatched disposition),
-- preserves correction lineage, and never promotes OCR candidates to geometry authority.

ALTER TABLE measurement_intake_receipts ADD COLUMN tenant_id TEXT CHECK (
  tenant_id IS NULL OR (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  )
);

-- Legacy receipts are only recoverable without guessing when the native operating core has one
-- unambiguous tenant. Multi-tenant and empty databases deliberately leave them quarantined.
UPDATE measurement_intake_receipts
   SET tenant_id = (
     SELECT CASE
       WHEN COUNT(DISTINCT tenant_id) = 1 THEN MIN(tenant_id)
       ELSE NULL
     END
       FROM operating_roof_jobs
   )
 WHERE tenant_id IS NULL
   AND status IN ('processing', 'retryable_error');

ALTER TABLE measurement_intake_receipts ADD COLUMN native_roof_job_id TEXT CHECK (
  native_roof_job_id IS NULL OR length(native_roof_job_id) BETWEEN 8 AND 200
);
ALTER TABLE measurement_intake_receipts ADD COLUMN native_measurement_revision_id TEXT CHECK (
  native_measurement_revision_id IS NULL OR (
    length(native_measurement_revision_id) = 69
    AND native_measurement_revision_id GLOB 'mrev_[0-9a-f]*'
    AND substr(native_measurement_revision_id, 6) NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE measurement_intake_receipts ADD COLUMN native_projection_sha256 TEXT CHECK (
  native_projection_sha256 IS NULL OR (
    length(native_projection_sha256) = 64
    AND native_projection_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE IF NOT EXISTS native_measurement_revisions (
  measurement_revision_id TEXT PRIMARY KEY CHECK (
    length(measurement_revision_id) = 69
    AND measurement_revision_id GLOB 'mrev_[0-9a-f]*'
    AND substr(measurement_revision_id, 6) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  receipt_id TEXT NOT NULL,
  measurement_id TEXT NOT NULL CHECK (
    length(measurement_id) = 76
    AND measurement_id GLOB 'measurement:[0-9a-f]*'
    AND substr(measurement_id, 13) NOT GLOB '*[^0-9a-f]*'
  ),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 3 AND 80),
  job_number TEXT CHECK (job_number IS NULL OR length(job_number) BETWEEN 1 AND 160),
  roof_job_id TEXT,
  operating_job_version INTEGER CHECK (
    operating_job_version IS NULL OR operating_job_version BETWEEN 1 AND 1000000
  ),
  association_status TEXT NOT NULL CHECK (association_status IN ('matched', 'unmatched')),
  association_error TEXT CHECK (
    association_error IS NULL OR length(association_error) BETWEEN 3 AND 120
  ),
  receipt_status TEXT NOT NULL CHECK (receipt_status IN ('matched', 'unmatched')),
  completion_reason TEXT CHECK (
    completion_reason IS NULL OR length(completion_reason) BETWEEN 3 AND 500
  ),
  review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
  root_measurement_id TEXT NOT NULL CHECK (
    length(root_measurement_id) = 76
    AND root_measurement_id GLOB 'measurement:[0-9a-f]*'
    AND substr(root_measurement_id, 13) NOT GLOB '*[^0-9a-f]*'
  ),
  revision_number INTEGER NOT NULL CHECK (revision_number BETWEEN 1 AND 1000000),
  supersedes_measurement_revision_id TEXT,
  correction_reason TEXT CHECK (
    correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 3 AND 500
  ),
  measurement_raw_key TEXT NOT NULL CHECK (
    measurement_raw_key GLOB 'raw/measurements/[0-9a-f]*.json'
    AND length(measurement_raw_key) = 86
    AND substr(measurement_raw_key, 18, 64) NOT GLOB '*[^0-9a-f]*'
  ),
  measurement_raw_sha256 TEXT NOT NULL CHECK (
    length(measurement_raw_sha256) = 64
    AND measurement_raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  report_raw_key TEXT,
  report_sha256 TEXT CHECK (
    report_sha256 IS NULL OR (
      length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  ocr_result_key TEXT,
  ocr_result_sha256 TEXT CHECK (
    ocr_result_sha256 IS NULL OR (
      length(ocr_result_sha256) = 64 AND ocr_result_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  projection_json TEXT NOT NULL CHECK (
    length(projection_json) BETWEEN 2 AND 2097152 AND json_valid(projection_json)
  ),
  projection_sha256 TEXT NOT NULL CHECK (
    length(projection_sha256) = 64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (measurement_revision_id, tenant_id),
  UNIQUE (receipt_id),
  UNIQUE (measurement_id),
  UNIQUE (tenant_id, root_measurement_id, revision_number),
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
  CHECK (receipt_status != 'matched' OR association_status = 'matched'),
  CHECK ((report_raw_key IS NULL) = (report_sha256 IS NULL)),
  CHECK ((ocr_result_key IS NULL) = (ocr_result_sha256 IS NULL)),
  CHECK (
    (revision_number = 1
      AND root_measurement_id = measurement_id
      AND supersedes_measurement_revision_id IS NULL
      AND correction_reason IS NULL)
    OR
    (revision_number > 1
      AND supersedes_measurement_revision_id IS NOT NULL
      AND correction_reason IS NOT NULL)
  ),
  FOREIGN KEY (receipt_id)
    REFERENCES measurement_intake_receipts(receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_measurement_revision_id, tenant_id)
    REFERENCES native_measurement_revisions(measurement_revision_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_native_measurement_revisions_job
  ON native_measurement_revisions (tenant_id, roof_job_id, created_at DESC)
  WHERE roof_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_native_measurement_revisions_root
  ON native_measurement_revisions (tenant_id, root_measurement_id, revision_number DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_native_measurement_revisions_one_successor
  ON native_measurement_revisions (tenant_id, supersedes_measurement_revision_id)
  WHERE supersedes_measurement_revision_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS native_measurement_revisions_receipt_guard
BEFORE INSERT ON native_measurement_revisions
WHEN NOT EXISTS (
  SELECT 1
    FROM measurement_intake_receipts AS receipt
   WHERE receipt.receipt_id = NEW.receipt_id
     AND receipt.tenant_id = NEW.tenant_id
     AND receipt.measurement_id = NEW.measurement_id
     AND receipt.provider = NEW.provider
     AND receipt.job_number IS NEW.job_number
     AND receipt.raw_key = NEW.measurement_raw_key
     AND receipt.payload_hash = NEW.measurement_raw_sha256
     AND receipt.report_raw_key IS NEW.report_raw_key
     AND receipt.report_sha256 IS NEW.report_sha256
     AND receipt.ocr_result_key IS NEW.ocr_result_key
     AND receipt.ocr_result_sha256 IS NEW.ocr_result_sha256
     AND receipt.status = 'processing'
     AND receipt.lease_token IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'native_measurement_receipt_evidence_mismatch'); END;

CREATE TRIGGER IF NOT EXISTS native_measurement_revisions_job_guard
BEFORE INSERT ON native_measurement_revisions
WHEN NEW.association_status = 'matched' AND NOT EXISTS (
  SELECT 1
    FROM operating_roof_jobs AS job
   WHERE job.tenant_id = NEW.tenant_id
     AND job.roof_job_id = NEW.roof_job_id
     AND job.job_number = NEW.job_number
     AND job.version = NEW.operating_job_version
)
BEGIN SELECT RAISE(ABORT, 'native_measurement_job_anchor_mismatch'); END;

CREATE TRIGGER IF NOT EXISTS native_measurement_revisions_lineage_guard
BEFORE INSERT ON native_measurement_revisions
WHEN NEW.revision_number > 1 AND NOT EXISTS (
  SELECT 1
    FROM native_measurement_revisions AS predecessor
   WHERE predecessor.tenant_id = NEW.tenant_id
     AND predecessor.measurement_revision_id = NEW.supersedes_measurement_revision_id
     AND predecessor.root_measurement_id = NEW.root_measurement_id
     AND predecessor.revision_number = NEW.revision_number - 1
)
BEGIN SELECT RAISE(ABORT, 'native_measurement_lineage_mismatch'); END;

CREATE TRIGGER IF NOT EXISTS native_measurement_revisions_no_insert_replace
BEFORE INSERT ON native_measurement_revisions
WHEN EXISTS (
  SELECT 1
    FROM native_measurement_revisions AS existing
   WHERE existing.measurement_revision_id = NEW.measurement_revision_id
      OR existing.receipt_id = NEW.receipt_id
      OR existing.measurement_id = NEW.measurement_id
      OR (
        existing.tenant_id = NEW.tenant_id
        AND existing.root_measurement_id = NEW.root_measurement_id
        AND existing.revision_number = NEW.revision_number
      )
      OR (
        NEW.supersedes_measurement_revision_id IS NOT NULL
        AND existing.tenant_id = NEW.tenant_id
        AND existing.supersedes_measurement_revision_id = NEW.supersedes_measurement_revision_id
      )
)
BEGIN SELECT RAISE(ABORT, 'native_measurement_insert_replace_forbidden'); END;

CREATE TRIGGER IF NOT EXISTS native_measurement_revisions_append_only_update
BEFORE UPDATE ON native_measurement_revisions
BEGIN SELECT RAISE(ABORT, 'native_measurement_revisions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS native_measurement_revisions_append_only_delete
BEFORE DELETE ON native_measurement_revisions
BEGIN SELECT RAISE(ABORT, 'native_measurement_revisions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS measurement_intake_receipts_native_binding_guard
BEFORE UPDATE ON measurement_intake_receipts
WHEN
  (NEW.native_measurement_revision_id IS NULL) != (NEW.native_projection_sha256 IS NULL)
  OR (NEW.native_measurement_revision_id IS NULL AND NEW.native_roof_job_id IS NOT NULL)
  OR (NEW.native_measurement_revision_id IS NOT NULL AND NEW.tenant_id IS NULL)
  OR (
    NEW.status IN ('matched', 'unmatched')
    AND NEW.tenant_id IS NOT NULL
    AND NEW.native_measurement_revision_id IS NULL
  )
  OR (
    OLD.native_measurement_revision_id IS NOT NULL
    AND (
      NEW.tenant_id IS NOT OLD.tenant_id
      OR NEW.native_roof_job_id IS NOT OLD.native_roof_job_id
      OR NEW.native_measurement_revision_id IS NOT OLD.native_measurement_revision_id
      OR NEW.native_projection_sha256 IS NOT OLD.native_projection_sha256
    )
  )
  OR (
    NEW.native_measurement_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM native_measurement_revisions AS revision
       WHERE revision.measurement_revision_id = NEW.native_measurement_revision_id
         AND revision.receipt_id = NEW.receipt_id
         AND revision.tenant_id = NEW.tenant_id
         AND revision.measurement_id = NEW.measurement_id
         AND revision.provider = NEW.provider
         AND revision.job_number IS NEW.job_number
         AND revision.roof_job_id IS NEW.native_roof_job_id
         AND revision.measurement_raw_key = NEW.raw_key
         AND revision.measurement_raw_sha256 = NEW.payload_hash
         AND revision.report_raw_key IS NEW.report_raw_key
         AND revision.report_sha256 IS NEW.report_sha256
         AND revision.ocr_result_key IS NEW.ocr_result_key
         AND revision.ocr_result_sha256 IS NEW.ocr_result_sha256
         AND revision.projection_sha256 = NEW.native_projection_sha256
         AND revision.receipt_status = NEW.status
    )
  )
  OR EXISTS (
    SELECT 1
      FROM native_measurement_revisions AS revision
     WHERE revision.receipt_id = OLD.receipt_id
       AND (
         revision.tenant_id IS NOT NEW.tenant_id
         OR revision.measurement_id IS NOT NEW.measurement_id
         OR revision.provider IS NOT NEW.provider
         OR revision.job_number IS NOT NEW.job_number
         OR revision.measurement_raw_key IS NOT NEW.raw_key
         OR revision.measurement_raw_sha256 IS NOT NEW.payload_hash
         OR revision.report_raw_key IS NOT NEW.report_raw_key
         OR revision.report_sha256 IS NOT NEW.report_sha256
         OR revision.ocr_result_key IS NOT NEW.ocr_result_key
         OR revision.ocr_result_sha256 IS NOT NEW.ocr_result_sha256
       )
  )
BEGIN SELECT RAISE(ABORT, 'measurement_native_binding_immutable'); END;
