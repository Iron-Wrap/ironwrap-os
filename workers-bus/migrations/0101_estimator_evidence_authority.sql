-- 0101_estimator_evidence_authority.sql - native Estimator evidence authority.
--
-- This aggregate does not copy commercial, inventory, work-package, or accounting state.
-- It binds the Estimator-only measurement/geometry/visual/takeoff/scope/insurance projection
-- to the existing native job, measurement R2 receipt, optional signed Facet v2 decision, and
-- optional commercial quote head. Revisions are immutable and corrections are explicit.

CREATE TABLE IF NOT EXISTS estimator_evidence_revisions (
  estimator_revision_id TEXT PRIMARY KEY CHECK (
    length(estimator_revision_id) BETWEEN 20 AND 160
    AND estimator_revision_id GLOB '[A-Za-z0-9]*'
    AND estimator_revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  roof_job_id TEXT NOT NULL,
  operating_job_version INTEGER NOT NULL CHECK (
    operating_job_version BETWEEN 1 AND 1000000
  ),
  revision_number INTEGER NOT NULL CHECK (revision_number BETWEEN 1 AND 1000000),
  supersedes_estimator_revision_id TEXT,
  measurement_receipt_id TEXT NOT NULL,
  measurement_raw_key TEXT NOT NULL CHECK (
    measurement_raw_key GLOB 'raw/measurements/[0-9a-f]*.json'
    AND length(measurement_raw_key) = 86
    AND substr(measurement_raw_key, 18, 64) NOT GLOB '*[^0-9a-f]*'
  ),
  measurement_raw_sha256 TEXT NOT NULL CHECK (
    length(measurement_raw_sha256) = 64
    AND measurement_raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  facet_event_id TEXT,
  facet_raw_key TEXT CHECK (
    facet_raw_key IS NULL OR facet_raw_key GLOB 'facet-design/v2/raw/*.json'
  ),
  facet_raw_sha256 TEXT CHECK (
    facet_raw_sha256 IS NULL OR (
      length(facet_raw_sha256) = 64
      AND facet_raw_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  facet_design_revision_id TEXT,
  facet_design_revision_sha256 TEXT CHECK (
    facet_design_revision_sha256 IS NULL OR (
      length(facet_design_revision_sha256) = 64
      AND facet_design_revision_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  facet_frozen_evidence_sha256 TEXT CHECK (
    facet_frozen_evidence_sha256 IS NULL OR (
      length(facet_frozen_evidence_sha256) = 64
      AND facet_frozen_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  commercial_quote_revision_id TEXT,
  payload_json TEXT NOT NULL CHECK (
    length(payload_json) BETWEEN 2 AND 262144 AND json_valid(payload_json)
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(evidence_refs_json) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  correction_reason TEXT,
  imported_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (estimator_revision_id, tenant_id),
  UNIQUE (tenant_id, roof_job_id, revision_number),
  UNIQUE (tenant_id, idempotency_key_hash),
  CHECK (
    (revision_number = 1
      AND supersedes_estimator_revision_id IS NULL
      AND correction_reason IS NULL)
    OR
    (revision_number > 1
      AND supersedes_estimator_revision_id IS NOT NULL
      AND length(trim(correction_reason)) BETWEEN 3 AND 2000)
  ),
  CHECK (
    (facet_event_id IS NULL
      AND facet_raw_key IS NULL
      AND facet_raw_sha256 IS NULL
      AND facet_design_revision_id IS NULL
      AND facet_design_revision_sha256 IS NULL
      AND facet_frozen_evidence_sha256 IS NULL)
    OR
    (facet_event_id IS NOT NULL
      AND facet_raw_key IS NOT NULL
      AND facet_raw_sha256 IS NOT NULL
      AND facet_design_revision_id IS NOT NULL
      AND facet_design_revision_sha256 IS NOT NULL
      AND facet_frozen_evidence_sha256 IS NOT NULL)
  ),
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (measurement_receipt_id)
    REFERENCES measurement_intake_receipts(receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY (facet_event_id)
    REFERENCES facet_v2_customer_decisions(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (commercial_quote_revision_id, tenant_id)
    REFERENCES commercial_quote_revisions(quote_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_estimator_revision_id, tenant_id)
    REFERENCES estimator_evidence_revisions(estimator_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (imported_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_estimator_evidence_job_revision
  ON estimator_evidence_revisions (tenant_id, roof_job_id, revision_number DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estimator_evidence_measurement
  ON estimator_evidence_revisions (tenant_id, measurement_receipt_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_estimator_evidence_facet
  ON estimator_evidence_revisions (tenant_id, facet_event_id, revision_number DESC)
  WHERE facet_event_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS estimator_evidence_revisions_immutable_update
BEFORE UPDATE ON estimator_evidence_revisions
BEGIN
  SELECT RAISE(ABORT, 'estimator_evidence_revisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS estimator_evidence_revisions_immutable_delete
BEFORE DELETE ON estimator_evidence_revisions
BEGIN
  SELECT RAISE(ABORT, 'estimator_evidence_revisions are append-only');
END;
