-- 0032_facet_design_frappe_projection.sql - append-only evidence/reconciliation attempts.
--
-- This is deliberately not a commercial ledger.  The Facet event remains immutable in
-- `facet_design_events`; this table records only whether its exact anchors were held, rejected,
-- or projected as review-only Frappe evidence under an explicit deployment configuration.

CREATE TABLE IF NOT EXISTS facet_design_projection_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (
    length(attempt_id) BETWEEN 24 AND 140
    AND attempt_id GLOB '[A-Za-z0-9]*'
    AND attempt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  facet_project_id TEXT NOT NULL CHECK (
    length(facet_project_id) BETWEEN 8 AND 160
    AND facet_project_id GLOB '[A-Za-z0-9]*'
    AND facet_project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  design_revision_id TEXT NOT NULL CHECK (
    length(design_revision_id) BETWEEN 8 AND 160
    AND design_revision_id GLOB '[A-Za-z0-9]*'
    AND design_revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  design_revision_sha256 TEXT NOT NULL CHECK (
    length(design_revision_sha256) = 64
    AND design_revision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  frozen_evidence_sha256 TEXT NOT NULL CHECK (
    length(frozen_evidence_sha256) = 64
    AND frozen_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_key TEXT NOT NULL CHECK (
    raw_key GLOB 'facet-design/v1/*'
    AND raw_key NOT GLOB '*..*'
    AND length(raw_key) BETWEEN 29 AND 192
  ),
  raw_sha256 TEXT NOT NULL CHECK (
    length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_content_length INTEGER NOT NULL CHECK (raw_content_length BETWEEN 2 AND 524288),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  association_sha256 TEXT NOT NULL DEFAULT '' CHECK (
    association_sha256 = ''
    OR (length(association_sha256) = 64 AND association_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  roof_job_id TEXT,
  customer_quote_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'held_missing_association',
    'rejected_association_mismatch',
    'projected',
    'rejected_frappe',
    'uncertain'
  )),
  evidence_id TEXT,
  reconciliation_id TEXT,
  error_code TEXT,
  attempted_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES facet_design_events(event_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_facet_design_projection_attempts_event_time
  ON facet_design_projection_attempts (event_id, attempted_at DESC);

-- A successful projection is terminal for an immutable source event.  A Frappe retry can race,
-- but the Frappe command is also idempotent and this index leaves only one durable success.
CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_design_projection_one_success
  ON facet_design_projection_attempts (event_id)
  WHERE outcome = 'projected';

-- A permanent Frappe 4xx refusal is terminal and operator-visible.  It must not become an
-- unbounded scheduled retry; a later correction requires a new immutable design revision.
CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_design_projection_one_frappe_rejection
  ON facet_design_projection_attempts (event_id)
  WHERE outcome = 'rejected_frappe';

-- Keep repeated sweeps from duplicating an unchanged missing/mismatched configuration finding.
-- A corrected deployment configuration produces a different association hash and is re-evaluated.
CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_design_projection_distinct_hold
  ON facet_design_projection_attempts (event_id, outcome, association_sha256)
  WHERE outcome IN ('held_missing_association', 'rejected_association_mismatch');

CREATE TRIGGER IF NOT EXISTS facet_design_projection_attempts_append_only_update
BEFORE UPDATE ON facet_design_projection_attempts
BEGIN
  SELECT RAISE(ABORT, 'facet_design_projection_attempts_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_projection_attempts_append_only_delete
BEFORE DELETE ON facet_design_projection_attempts
BEGIN
  SELECT RAISE(ABORT, 'facet_design_projection_attempts_append_only');
END;
