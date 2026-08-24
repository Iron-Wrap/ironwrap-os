-- 0121_facet_prequote_estimator_consumer.sql
--
-- Prequote Facet authority is a separate append-only lane.  It deliberately does not loosen
-- facet_v2_project_links or facet_v2_project_launches: those tables remain quote-bound.

CREATE TABLE IF NOT EXISTS facet_v2_prequote_project_links (
  external_project_link_id TEXT PRIMARY KEY CHECK (
    external_project_link_id GLOB 'ironwrap-project-v1:*'
    AND length(external_project_link_id) = 84
  ),
  producer_identity_link_id TEXT NOT NULL,
  destination_tenant_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  facet_project_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_party_ref TEXT NOT NULL CHECK (
    length(customer_party_ref) = 64 AND customer_party_ref NOT GLOB '*[^0-9a-f]*'
  ),
  external_customer_identity_link_id TEXT NOT NULL CHECK (
    external_customer_identity_link_id GLOB 'facet-customer-oidc-v1:*'
    AND length(external_customer_identity_link_id) = 87
  ),
  roof_job_id TEXT NOT NULL,
  project_claim_sha256 TEXT NOT NULL CHECK (
    length(project_claim_sha256) = 64 AND project_claim_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  association_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(association_sha256) = 64 AND association_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (destination_tenant_id, facet_project_id),
  FOREIGN KEY (producer_identity_link_id)
    REFERENCES facet_v2_producer_identity_links(producer_identity_link_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id, destination_tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_facet_v2_prequote_project_links_job
  ON facet_v2_prequote_project_links (destination_tenant_id, roof_job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS facet_v2_prequote_project_launches (
  facet_project_id TEXT PRIMARY KEY,
  external_project_link_id TEXT NOT NULL UNIQUE,
  destination_tenant_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  -- Producer does not assert IronWrap job/customer identity.  Accepted rows receive these
  -- values from the exact prequote association; rejected rows may retain NULLs for replay proof.
  roof_job_id TEXT,
  customer_id TEXT,
  customer_party_ref TEXT NOT NULL CHECK (
    length(customer_party_ref) = 64 AND customer_party_ref NOT GLOB '*[^0-9a-f]*'
  ),
  external_customer_identity_link_id TEXT NOT NULL CHECK (
    external_customer_identity_link_id GLOB 'facet-customer-oidc-v1:*'
    AND length(external_customer_identity_link_id) = 87
  ),
  issued_by_user_id TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_sha256) = 64 AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  launch_intent_sha256 TEXT NOT NULL CHECK (
    length(launch_intent_sha256) = 64 AND launch_intent_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  launch_envelope_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(launch_envelope_sha256) = 64 AND launch_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at INTEGER NOT NULL,
  not_before INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (
    not_before >= issued_at AND expires_at > issued_at AND expires_at - issued_at <= 1800
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (external_project_link_id)
    REFERENCES facet_v2_prequote_project_links(external_project_link_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (issued_by_user_id, destination_tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_facet_v2_prequote_project_launches_job
  ON facet_v2_prequote_project_launches (destination_tenant_id, roof_job_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS facet_v2_estimator_ready_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 8 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  event_type TEXT NOT NULL CHECK (event_type = 'facet.design.estimator_ready.v1'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_body_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(event_body_sha256) = 64 AND event_body_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  issuer TEXT NOT NULL,
  source_product TEXT NOT NULL CHECK (source_product = 'facet'),
  source_environment TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  destination_tenant_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  facet_project_id TEXT NOT NULL,
  external_project_link_id TEXT NOT NULL,
  producer_identity_link_id TEXT NOT NULL,
  roof_job_id TEXT,
  customer_id TEXT,
  actor_identity_ref TEXT NOT NULL CHECK (
    actor_identity_ref GLOB 'facet-actor-oidc-v1:*'
    AND length(actor_identity_ref) = 84
  ),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'expert')),
  oidc_issuer TEXT NOT NULL,
  oidc_subject_sha256 TEXT NOT NULL CHECK (
    length(oidc_subject_sha256) = 64 AND oidc_subject_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  previous_event_id TEXT,
  design_revision_id TEXT NOT NULL,
  design_revision_sha256 TEXT NOT NULL CHECK (
    length(design_revision_sha256) = 64 AND design_revision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  frozen_evidence_sha256 TEXT NOT NULL CHECK (
    length(frozen_evidence_sha256) = 64 AND frozen_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_key TEXT NOT NULL UNIQUE CHECK (
    raw_key GLOB 'facet-estimator-ready/v1/raw/*.json'
    AND raw_key NOT GLOB '*..*'
    AND length(raw_key) BETWEEN 36 AND 220
  ),
  raw_content_length INTEGER NOT NULL CHECK (raw_content_length BETWEEN 2 AND 524288),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('accepted', 'rejected')),
  detail_code TEXT NOT NULL,
  CHECK (
    (result = 'accepted' AND roof_job_id IS NOT NULL AND customer_id IS NOT NULL)
    OR (result = 'rejected' AND (
      (roof_job_id IS NULL AND customer_id IS NULL)
      OR (roof_job_id IS NOT NULL AND customer_id IS NOT NULL)
    ))
  ),
  UNIQUE (destination_tenant_id, facet_project_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_facet_v2_estimator_ready_events_project_time
  ON facet_v2_estimator_ready_events (destination_tenant_id, facet_project_id, occurred_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_v2_estimator_ready_events_initial
  ON facet_v2_estimator_ready_events (destination_tenant_id, facet_project_id)
  WHERE previous_event_id IS NULL AND result = 'accepted';

CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_v2_estimator_ready_events_predecessor
  ON facet_v2_estimator_ready_events (previous_event_id)
  WHERE previous_event_id IS NOT NULL AND result = 'accepted';

CREATE TABLE IF NOT EXISTS facet_v2_estimator_ready_nonces (
  nonce_sha256 TEXT PRIMARY KEY CHECK (
    length(nonce_sha256) = 64 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL,
  event_body_sha256 TEXT NOT NULL CHECK (
    length(event_body_sha256) = 64 AND event_body_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  received_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES facet_v2_estimator_ready_events(event_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facet_v2_estimator_ready_receipts (
  receipt_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_body_sha256 TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('accepted', 'rejected', 'duplicate')),
  detail_code TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'HMAC-SHA256'),
  signature_key_id TEXT NOT NULL,
  signature_key_version INTEGER NOT NULL CHECK (signature_key_version > 0),
  signature_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES facet_v2_estimator_ready_events(event_id) ON DELETE RESTRICT,
  UNIQUE (event_id, result)
);

CREATE INDEX IF NOT EXISTS idx_facet_v2_estimator_ready_receipts_event
  ON facet_v2_estimator_ready_receipts (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS facet_v2_estimator_ready_promotions (
  promotion_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  estimator_revision_id TEXT NOT NULL,
  external_project_link_id TEXT NOT NULL,
  destination_tenant_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_quote_id TEXT NOT NULL,
  quote_revision_id TEXT NOT NULL,
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  quote_approved_at TEXT NOT NULL,
  proposal_revision_id TEXT NOT NULL,
  proposal_pack_id TEXT NOT NULL,
  publication_event_id TEXT NOT NULL,
  acceptance_binding_id TEXT NOT NULL,
  acceptance_id TEXT NOT NULL,
  acceptance_receipt_hash TEXT NOT NULL CHECK (
    length(acceptance_receipt_hash) = 64 AND acceptance_receipt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  accepted_at TEXT NOT NULL,
  promoted_by_user_id TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_sha256) = 64 AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  promotion_intent_sha256 TEXT NOT NULL CHECK (
    length(promotion_intent_sha256) = 64 AND promotion_intent_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  promotion_anchor_sha256 TEXT NOT NULL CHECK (
    length(promotion_anchor_sha256) = 64 AND promotion_anchor_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  promoted_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES facet_v2_estimator_ready_events(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (estimator_revision_id)
    REFERENCES estimator_evidence_revisions(estimator_revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (external_project_link_id)
    REFERENCES facet_v2_prequote_project_links(external_project_link_id) ON DELETE RESTRICT,
  FOREIGN KEY (quote_revision_id, destination_tenant_id)
    REFERENCES commercial_quote_revisions(quote_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (promoted_by_user_id, destination_tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_facet_v2_estimator_ready_promotions_job
  ON facet_v2_estimator_ready_promotions (destination_tenant_id, roof_job_id, promoted_at DESC);

-- Keep the historical estimator_evidence_revisions positional insert contract intact. Ready
-- provenance is a separate immutable one-to-one anchor instead of widening that old table.
CREATE TABLE IF NOT EXISTS estimator_evidence_facet_ready_anchors (
  estimator_revision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  estimator_ready_event_id TEXT NOT NULL UNIQUE,
  estimator_ready_raw_key TEXT NOT NULL,
  estimator_ready_raw_sha256 TEXT NOT NULL CHECK (
    length(estimator_ready_raw_sha256) = 64
    AND estimator_ready_raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  estimator_ready_design_revision_id TEXT NOT NULL,
  estimator_ready_design_revision_sha256 TEXT NOT NULL CHECK (
    length(estimator_ready_design_revision_sha256) = 64
    AND estimator_ready_design_revision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  estimator_ready_frozen_evidence_sha256 TEXT NOT NULL CHECK (
    length(estimator_ready_frozen_evidence_sha256) = 64
    AND estimator_ready_frozen_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (estimator_revision_id)
    REFERENCES estimator_evidence_revisions(estimator_revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (estimator_ready_event_id)
    REFERENCES facet_v2_estimator_ready_events(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_estimator_evidence_estimator_ready
  ON estimator_evidence_facet_ready_anchors (tenant_id, estimator_ready_event_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS facet_v2_prequote_project_links_append_only_update
BEFORE UPDATE ON facet_v2_prequote_project_links BEGIN
  SELECT RAISE(ABORT, 'facet_v2_prequote_project_links_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_prequote_project_links_append_only_delete
BEFORE DELETE ON facet_v2_prequote_project_links BEGIN
  SELECT RAISE(ABORT, 'facet_v2_prequote_project_links_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_prequote_project_launches_append_only_update
BEFORE UPDATE ON facet_v2_prequote_project_launches BEGIN
  SELECT RAISE(ABORT, 'facet_v2_prequote_project_launches_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_prequote_project_launches_append_only_delete
BEFORE DELETE ON facet_v2_prequote_project_launches BEGIN
  SELECT RAISE(ABORT, 'facet_v2_prequote_project_launches_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_estimator_ready_events_append_only_update
BEFORE UPDATE ON facet_v2_estimator_ready_events BEGIN
  SELECT RAISE(ABORT, 'facet_v2_estimator_ready_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_estimator_ready_events_append_only_delete
BEFORE DELETE ON facet_v2_estimator_ready_events BEGIN
  SELECT RAISE(ABORT, 'facet_v2_estimator_ready_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_estimator_ready_nonces_append_only_update
BEFORE UPDATE ON facet_v2_estimator_ready_nonces BEGIN
  SELECT RAISE(ABORT, 'facet_v2_estimator_ready_nonces_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_estimator_ready_nonces_append_only_delete
BEFORE DELETE ON facet_v2_estimator_ready_nonces BEGIN
  SELECT RAISE(ABORT, 'facet_v2_estimator_ready_nonces_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_estimator_ready_receipts_append_only_update
BEFORE UPDATE ON facet_v2_estimator_ready_receipts BEGIN
  SELECT RAISE(ABORT, 'facet_v2_estimator_ready_receipts_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_estimator_ready_receipts_append_only_delete
BEFORE DELETE ON facet_v2_estimator_ready_receipts BEGIN
  SELECT RAISE(ABORT, 'facet_v2_estimator_ready_receipts_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_estimator_ready_promotions_append_only_update
BEFORE UPDATE ON facet_v2_estimator_ready_promotions BEGIN
  SELECT RAISE(ABORT, 'facet_v2_estimator_ready_promotions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_estimator_ready_promotions_append_only_delete
BEFORE DELETE ON facet_v2_estimator_ready_promotions BEGIN
  SELECT RAISE(ABORT, 'facet_v2_estimator_ready_promotions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS estimator_evidence_facet_ready_anchors_append_only_update
BEFORE UPDATE ON estimator_evidence_facet_ready_anchors BEGIN
  SELECT RAISE(ABORT, 'estimator_evidence_facet_ready_anchors_append_only');
END;
CREATE TRIGGER IF NOT EXISTS estimator_evidence_facet_ready_anchors_append_only_delete
BEFORE DELETE ON estimator_evidence_facet_ready_anchors BEGIN
  SELECT RAISE(ABORT, 'estimator_evidence_facet_ready_anchors_append_only');
END;
