-- 0019_measurement_intake_receipts.sql - durable, replay-safe measurement intake ledger.
--
-- A measurement report is not a lead envelope: it can arrive before a confident job match and
-- must remain operable rather than becoming an orphaned raw object.  The receipt holds a hashed
-- idempotency identity, a fixed raw R2 pointer, and the bounded downstream result.  Raw provider
-- ids and attachment identifiers are never persisted here; only their SHA-256-derived key hash is.

CREATE TABLE IF NOT EXISTS measurement_intake_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 76
    AND receipt_id GLOB 'measurement_[0-9a-f]*'
    AND substr(receipt_id, 13) NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64
    AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  key_strategy TEXT NOT NULL CHECK (
    key_strategy IN ('request_header', 'provider_attachment', 'attachment_job', 'payload_hash')
  ),
  measurement_id TEXT NOT NULL UNIQUE CHECK (
    length(measurement_id) = 76
    AND measurement_id GLOB 'measurement:[0-9a-f]*'
    AND substr(measurement_id, 13) NOT GLOB '*[^0-9a-f]*'
  ),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 3 AND 80),
  job_number TEXT CHECK (job_number IS NULL OR length(job_number) BETWEEN 1 AND 160),
  raw_key TEXT NOT NULL CHECK (
    raw_key GLOB 'raw/measurements/[0-9a-f]*.json'
    AND length(raw_key) = 86
    AND substr(raw_key, 18, 64) NOT GLOB '*[^0-9a-f]*'
  ),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 3 AND 120),
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'matched', 'unmatched', 'retryable_error')
  ),
  lease_token TEXT,
  lease_expires_at TEXT,
  drive_report_url TEXT CHECK (drive_report_url IS NULL OR length(drive_report_url) <= 2048),
  drive_folder_url TEXT CHECK (drive_folder_url IS NULL OR length(drive_folder_url) <= 2048),
  frappe_measurement_id TEXT CHECK (frappe_measurement_id IS NULL OR length(frappe_measurement_id) <= 255),
  frappe_evidence_id TEXT CHECK (frappe_evidence_id IS NULL OR length(frappe_evidence_id) <= 255),
  frappe_error TEXT CHECK (frappe_error IS NULL OR length(frappe_error) <= 500),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status IN ('matched', 'unmatched')
      AND completed_at IS NOT NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL)
    OR
    (status = 'processing'
      AND completed_at IS NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR
    (status = 'retryable_error'
      AND completed_at IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL)
  ),
  CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_measurement_intake_receipts_exception_updated
  ON measurement_intake_receipts (status, updated_at DESC);
