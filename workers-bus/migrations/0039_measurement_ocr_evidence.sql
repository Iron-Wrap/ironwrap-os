-- 0039_measurement_ocr_evidence.sql - immutable report/OCR evidence and provisional review state.
--
-- OCR output is evidence for a reviewer, never authority to select a job or clear review.  The
-- original report and normalized provider response are owned in R2 and pinned here by SHA-256 so
-- queue redelivery and cron recovery reuse the exact same artifacts instead of calling the model
-- again or trusting a mutable provider URL.

ALTER TABLE measurement_intake_receipts ADD COLUMN report_raw_key TEXT CHECK (
  report_raw_key IS NULL OR (
    length(report_raw_key) = 92 AND
    substr(report_raw_key, 1, 24) = 'raw/measurement-reports/' AND
    substr(report_raw_key, 25, 64) NOT GLOB '*[^0-9a-f]*' AND
    substr(report_raw_key, 89) = '.bin'
  )
);
ALTER TABLE measurement_intake_receipts ADD COLUMN report_sha256 TEXT CHECK (
  report_sha256 IS NULL OR (
    length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE measurement_intake_receipts ADD COLUMN report_content_type TEXT CHECK (
  report_content_type IS NULL OR length(report_content_type) BETWEEN 3 AND 120
);
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_status TEXT NOT NULL DEFAULT 'not_requested'
  CHECK (ocr_status IN ('not_requested', 'processing', 'completed', 'failed'));
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_model TEXT CHECK (
  ocr_model IS NULL OR length(ocr_model) BETWEEN 3 AND 80
);
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_result_key TEXT CHECK (
  ocr_result_key IS NULL OR (
    length(ocr_result_key) = 166 AND
    substr(ocr_result_key, 1, 32) = 'raw/measurement-ocr/measurement_' AND
    substr(ocr_result_key, 33, 64) NOT GLOB '*[^0-9a-f]*' AND
    substr(ocr_result_key, 97, 1) = '/' AND
    substr(ocr_result_key, 98, 64) NOT GLOB '*[^0-9a-f]*' AND
    substr(ocr_result_key, 162) = '.json'
  )
);
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_result_sha256 TEXT CHECK (
  ocr_result_sha256 IS NULL OR (
    length(ocr_result_sha256) = 64 AND ocr_result_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_job_number_candidate TEXT CHECK (
  ocr_job_number_candidate IS NULL OR length(ocr_job_number_candidate) BETWEEN 1 AND 160
);
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_job_number_source_ref TEXT CHECK (
  ocr_job_number_source_ref IS NULL OR length(ocr_job_number_source_ref) <= 240
);
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_review_required INTEGER NOT NULL DEFAULT 0
  CHECK (ocr_review_required IN (0, 1));
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_error TEXT CHECK (
  ocr_error IS NULL OR length(ocr_error) <= 500
);
ALTER TABLE measurement_intake_receipts ADD COLUMN ocr_completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_measurement_intake_receipts_ocr_review
  ON measurement_intake_receipts (ocr_review_required, ocr_status, updated_at DESC);

-- A Queue DLQ delivery may be repeated after a transient D1 failure. Keep one open operator
-- incident for that receipt while allowing a later recovered incident to be recorded again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dead_letter_open_measurement
  ON dead_letter (envelope_id, stage)
  WHERE recovered = 0 AND stage = 'measurement_processing';
