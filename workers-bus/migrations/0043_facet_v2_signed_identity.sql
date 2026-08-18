-- 0043_facet_v2_signed_identity.sql - signed Facet v2 identity and decision intake.
--
-- 0042 is intentionally reserved for IRO-38.  Existing v1 and bearer-capability
-- v2 tables remain immutable quarantine evidence; this migration creates the
-- only OIDC-assured path that may associate or project.

CREATE TABLE IF NOT EXISTS facet_v2_producer_identity_links (
  producer_identity_link_id TEXT PRIMARY KEY CHECK (
    producer_identity_link_id GLOB 'ironwrap-identity-v1:*'
    AND length(producer_identity_link_id) = 85
  ),
  destination_tenant_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  source_product TEXT NOT NULL CHECK (source_product = 'facet'),
  source_environment TEXT NOT NULL,
  proof_sha256 TEXT NOT NULL CHECK (
    length(proof_sha256) = 64 AND proof_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_from_project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (destination_tenant_id),
  UNIQUE (source_tenant_id)
);

CREATE TABLE IF NOT EXISTS facet_v2_project_links (
  external_project_link_id TEXT PRIMARY KEY CHECK (
    external_project_link_id GLOB 'ironwrap-project-v1:*'
    AND length(external_project_link_id) = 84
  ),
  producer_identity_link_id TEXT NOT NULL,
  destination_tenant_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  facet_project_id TEXT NOT NULL,
  customer_party_ref TEXT NOT NULL CHECK (
    length(customer_party_ref) = 64 AND customer_party_ref NOT GLOB '*[^0-9a-f]*'
  ),
  external_customer_identity_link_id TEXT NOT NULL CHECK (
    external_customer_identity_link_id GLOB 'facet-customer-oidc-v1:*'
    AND length(external_customer_identity_link_id) = 87
  ),
  roof_job_id TEXT NOT NULL,
  customer_quote_id TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS facet_v2_project_launches (
  facet_project_id TEXT PRIMARY KEY,
  external_project_link_id TEXT NOT NULL UNIQUE,
  destination_tenant_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  customer_quote_id TEXT NOT NULL,
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  quote_approved_at TEXT NOT NULL,
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
    REFERENCES facet_v2_project_links(external_project_link_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (issued_by_user_id, destination_tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facet_v2_link_revocations (
  revocation_id TEXT PRIMARY KEY,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('producer_identity', 'project', 'customer_identity')),
  link_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  revoked_by_user_id TEXT NOT NULL,
  destination_tenant_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  UNIQUE (link_kind, link_id),
  FOREIGN KEY (revoked_by_user_id, destination_tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS facet_v2_raw_intakes (
  intake_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_body_sha256 TEXT NOT NULL CHECK (
    length(event_body_sha256) = 64 AND event_body_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_key TEXT NOT NULL CHECK (raw_key GLOB 'facet-design/v2/raw/*.json'),
  raw_sha256 TEXT NOT NULL CHECK (raw_sha256 = event_body_sha256),
  raw_content_length INTEGER NOT NULL CHECK (raw_content_length BETWEEN 2 AND 524288),
  issuer TEXT NOT NULL,
  source_product TEXT NOT NULL CHECK (source_product = 'facet'),
  source_environment TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  destination_tenant_id TEXT NOT NULL,
  delivery_key_id TEXT NOT NULL,
  delivery_key_version INTEGER NOT NULL CHECK (delivery_key_version > 0),
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms),
  nonce_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(nonce_sha256) = 64 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  result TEXT NOT NULL CHECK (result IN (
    'accepted_associated', 'accepted_unassociated', 'rejected', 'duplicate'
  )),
  detail_code TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facet_v2_raw_intakes_event_time
  ON facet_v2_raw_intakes (event_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_facet_v2_raw_intakes_unassociated
  ON facet_v2_raw_intakes (result, received_at)
  WHERE result = 'accepted_unassociated';

CREATE TABLE IF NOT EXISTS facet_v2_customer_decisions (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type = 'facet.design.customer_approved.v2'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  event_body_sha256 TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL,
  source_product TEXT NOT NULL CHECK (source_product = 'facet'),
  source_environment TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  destination_tenant_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  facet_project_id TEXT NOT NULL,
  external_project_link_id TEXT NOT NULL,
  producer_identity_link_id TEXT NOT NULL,
  association_sha256 TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  customer_quote_id TEXT NOT NULL,
  customer_party_ref TEXT NOT NULL,
  external_customer_identity_link_id TEXT NOT NULL,
  oidc_issuer TEXT NOT NULL,
  oidc_subject_sha256 TEXT NOT NULL,
  identity_assurance TEXT NOT NULL CHECK (identity_assurance = 'oidc'),
  attestation_version TEXT NOT NULL CHECK (attestation_version = 'facet-customer-approval-v1'),
  decision_kind TEXT NOT NULL CHECK (
    decision_kind IN ('approved', 'corrected', 'superseded', 'withdrawn')
  ),
  previous_event_id TEXT,
  reason_sha256 TEXT,
  approval_receipt_id TEXT NOT NULL UNIQUE,
  approval_receipt_sha256 TEXT NOT NULL UNIQUE,
  design_revision_id TEXT NOT NULL,
  design_revision_sha256 TEXT NOT NULL,
  frozen_evidence_sha256 TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  raw_content_length INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (external_project_link_id)
    REFERENCES facet_v2_project_links(external_project_link_id) ON DELETE RESTRICT,
  FOREIGN KEY (producer_identity_link_id)
    REFERENCES facet_v2_producer_identity_links(producer_identity_link_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_event_id)
    REFERENCES facet_v2_customer_decisions(event_id) ON DELETE RESTRICT,
  CHECK (
    (decision_kind = 'approved' AND previous_event_id IS NULL AND reason_sha256 IS NULL)
    OR
    (decision_kind <> 'approved' AND previous_event_id IS NOT NULL AND reason_sha256 IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_v2_decision_initial_project
  ON facet_v2_customer_decisions (destination_tenant_id, facet_project_id)
  WHERE previous_event_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_v2_decision_predecessor
  ON facet_v2_customer_decisions (previous_event_id)
  WHERE previous_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facet_v2_decision_project_time
  ON facet_v2_customer_decisions (destination_tenant_id, facet_project_id, occurred_at);

CREATE TABLE IF NOT EXISTS facet_v2_consumer_receipts (
  receipt_id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_body_sha256 TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN (
    'accepted_unassociated', 'accepted_associated', 'rejected', 'reconciled', 'duplicate'
  )),
  detail_code TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL UNIQUE,
  signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'HMAC-SHA256'),
  signature_key_id TEXT NOT NULL,
  signature_key_version INTEGER NOT NULL CHECK (signature_key_version > 0),
  signature_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (intake_id) REFERENCES facet_v2_raw_intakes(intake_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_v2_receipt_result_once
  ON facet_v2_consumer_receipts (intake_id, result);

CREATE TABLE IF NOT EXISTS facet_v2_projection_attempts (
  attempt_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'projected_blank_draft', 'projected_terminal_hold', 'reconciled', 'rejected_frappe', 'uncertain',
    'held_withdrawn', 'held_superseded'
  )),
  evidence_id TEXT,
  reconciliation_id TEXT,
  draft_customer_quote_id TEXT,
  draft_quote_version INTEGER,
  error_code TEXT,
  attempted_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES facet_v2_customer_decisions(event_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_v2_projection_one_success
  ON facet_v2_projection_attempts (event_id)
  WHERE outcome IN ('projected_blank_draft', 'projected_terminal_hold', 'reconciled');

CREATE TRIGGER IF NOT EXISTS facet_v2_identity_links_append_only_update
BEFORE UPDATE ON facet_v2_producer_identity_links BEGIN
  SELECT RAISE(ABORT, 'facet_v2_identity_links_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_identity_links_append_only_delete
BEFORE DELETE ON facet_v2_producer_identity_links BEGIN
  SELECT RAISE(ABORT, 'facet_v2_identity_links_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_project_links_append_only_update
BEFORE UPDATE ON facet_v2_project_links BEGIN
  SELECT RAISE(ABORT, 'facet_v2_project_links_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_project_links_append_only_delete
BEFORE DELETE ON facet_v2_project_links BEGIN
  SELECT RAISE(ABORT, 'facet_v2_project_links_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_project_launches_append_only_update
BEFORE UPDATE ON facet_v2_project_launches BEGIN
  SELECT RAISE(ABORT, 'facet_v2_project_launches_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_project_launches_append_only_delete
BEFORE DELETE ON facet_v2_project_launches BEGIN
  SELECT RAISE(ABORT, 'facet_v2_project_launches_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_link_revocations_append_only_update
BEFORE UPDATE ON facet_v2_link_revocations BEGIN
  SELECT RAISE(ABORT, 'facet_v2_link_revocations_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_link_revocations_append_only_delete
BEFORE DELETE ON facet_v2_link_revocations BEGIN
  SELECT RAISE(ABORT, 'facet_v2_link_revocations_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_raw_intakes_append_only_update
BEFORE UPDATE ON facet_v2_raw_intakes BEGIN
  SELECT RAISE(ABORT, 'facet_v2_raw_intakes_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_raw_intakes_append_only_delete
BEFORE DELETE ON facet_v2_raw_intakes BEGIN
  SELECT RAISE(ABORT, 'facet_v2_raw_intakes_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_customer_decisions_append_only_update
BEFORE UPDATE ON facet_v2_customer_decisions BEGIN
  SELECT RAISE(ABORT, 'facet_v2_customer_decisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_customer_decisions_append_only_delete
BEFORE DELETE ON facet_v2_customer_decisions BEGIN
  SELECT RAISE(ABORT, 'facet_v2_customer_decisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_consumer_receipts_append_only_update
BEFORE UPDATE ON facet_v2_consumer_receipts BEGIN
  SELECT RAISE(ABORT, 'facet_v2_consumer_receipts_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_consumer_receipts_append_only_delete
BEFORE DELETE ON facet_v2_consumer_receipts BEGIN
  SELECT RAISE(ABORT, 'facet_v2_consumer_receipts_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_projection_attempts_append_only_update
BEFORE UPDATE ON facet_v2_projection_attempts BEGIN
  SELECT RAISE(ABORT, 'facet_v2_projection_attempts_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_projection_attempts_append_only_delete
BEFORE DELETE ON facet_v2_projection_attempts BEGIN
  SELECT RAISE(ABORT, 'facet_v2_projection_attempts_append_only');
END;
