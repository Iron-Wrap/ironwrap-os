-- 0035_facet_design_evidence_associations.sql - operator-authored Facet evidence bindings.
--
-- Only provenance-bearing customer approvals may enter this ledger. The row binds immutable
-- evidence anchors to already-existing IronWrap records; it does not copy or mutate quote terms.

CREATE TABLE IF NOT EXISTS facet_design_evidence_associations (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 8 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  brand_id TEXT NOT NULL CHECK (
    length(brand_id) BETWEEN 2 AND 32
    AND brand_id NOT GLOB '*[^a-z0-9-]*'
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
  roof_job_id TEXT NOT NULL CHECK (
    length(roof_job_id) BETWEEN 3 AND 140
    AND roof_job_id GLOB '[A-Za-z0-9]*'
    AND roof_job_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  customer_quote_id TEXT NOT NULL CHECK (
    length(customer_quote_id) BETWEEN 3 AND 140
    AND customer_quote_id GLOB '[A-Za-z0-9]*'
    AND customer_quote_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  associated_by_user_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    length(reason) BETWEEN 8 AND 1000
    AND instr(reason, char(0)) = 0
  ),
  idempotency_key_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_sha256) = 64
    AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  association_intent_sha256 TEXT NOT NULL CHECK (
    length(association_intent_sha256) = 64
    AND association_intent_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  association_anchor_sha256 TEXT NOT NULL CHECK (
    length(association_anchor_sha256) = 64
    AND association_anchor_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  associated_at TEXT NOT NULL CHECK (length(associated_at) BETWEEN 24 AND 40),
  FOREIGN KEY (event_id)
    REFERENCES facet_customer_approval_events(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (associated_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_facet_design_evidence_associations_tenant_time
  ON facet_design_evidence_associations (tenant_id, associated_at DESC);

CREATE TRIGGER IF NOT EXISTS facet_design_evidence_associations_validate_insert
BEFORE INSERT ON facet_design_evidence_associations
BEGIN
  SELECT RAISE(ABORT, 'facet_design_association_event_anchor_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM facet_customer_approval_events AS event
    WHERE event.event_id = NEW.event_id
      AND event.event_type = 'facet.design.customer_approved.v2'
      AND event.schema_version = 2
      AND event.approval_actor_type = 'customer_capability'
      AND event.tenant_id = NEW.tenant_id
      AND event.brand_id = NEW.brand_id
      AND event.facet_project_id = NEW.facet_project_id
      AND event.design_revision_id = NEW.design_revision_id
      AND event.design_revision_sha256 = NEW.design_revision_sha256
      AND event.frozen_evidence_sha256 = NEW.frozen_evidence_sha256
  );
  SELECT RAISE(ABORT, 'facet_design_association_office_actor_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM app_users AS actor
    WHERE actor.user_id = NEW.associated_by_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND actor.role IN ('owner', 'ops')
  );
END;

CREATE TRIGGER IF NOT EXISTS facet_design_evidence_associations_append_only_update
BEFORE UPDATE ON facet_design_evidence_associations
BEGIN
  SELECT RAISE(ABORT, 'facet_design_evidence_associations_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_evidence_associations_append_only_delete
BEFORE DELETE ON facet_design_evidence_associations
BEGIN
  SELECT RAISE(ABORT, 'facet_design_evidence_associations_append_only');
END;

-- v1 attempts retain their original table and provenance. v2 needs a separate foreign key so a
-- legacy row can never be relabelled as a customer approval merely to satisfy projection.
CREATE TABLE IF NOT EXISTS facet_customer_approval_projection_attempts (
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
  brand_id TEXT NOT NULL CHECK (
    length(brand_id) BETWEEN 2 AND 32
    AND brand_id NOT GLOB '*[^a-z0-9-]*'
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
    raw_key GLOB 'facet-design/v2/*'
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
  FOREIGN KEY (event_id)
    REFERENCES facet_customer_approval_events(event_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_facet_customer_projection_attempts_event_time
  ON facet_customer_approval_projection_attempts (event_id, attempted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_customer_projection_one_success
  ON facet_customer_approval_projection_attempts (event_id)
  WHERE outcome = 'projected';

CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_customer_projection_one_frappe_rejection
  ON facet_customer_approval_projection_attempts (event_id)
  WHERE outcome = 'rejected_frappe';

CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_customer_projection_distinct_hold
  ON facet_customer_approval_projection_attempts (event_id, outcome, association_sha256)
  WHERE outcome IN ('held_missing_association', 'rejected_association_mismatch');

CREATE TRIGGER IF NOT EXISTS facet_customer_approval_projection_attempts_append_only_update
BEFORE UPDATE ON facet_customer_approval_projection_attempts
BEGIN
  SELECT RAISE(ABORT, 'facet_customer_approval_projection_attempts_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_customer_approval_projection_attempts_append_only_delete
BEFORE DELETE ON facet_customer_approval_projection_attempts
BEGIN
  SELECT RAISE(ABORT, 'facet_customer_approval_projection_attempts_append_only');
END;
