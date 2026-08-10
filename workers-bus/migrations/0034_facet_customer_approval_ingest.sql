-- 0034_facet_customer_approval_ingest.sql - provenance-bearing Facet customer approvals.
--
-- Legacy `facet.design.approved.v1` receipts remain immutable, provenance-unknown evidence in
-- facet_design_events.  Customer-capability approvals have a separate append-only table so a v1
-- row can never be upgraded by inference.  Both versions share one nonce registry from this point
-- forward, including a backfill of every landed v1 nonce.

CREATE TABLE IF NOT EXISTS facet_customer_approval_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 8 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  event_type TEXT NOT NULL CHECK (event_type = 'facet.design.customer_approved.v2'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 24 AND 40),
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
  approval_actor_type TEXT NOT NULL CHECK (approval_actor_type = 'customer_capability'),
  identity_assurance TEXT NOT NULL CHECK (identity_assurance = 'bearer_capability_only'),
  capability_fingerprint TEXT NOT NULL CHECK (
    length(capability_fingerprint) = 64
    AND capability_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  raw_key TEXT NOT NULL UNIQUE CHECK (
    raw_key GLOB 'facet-design/v2/*'
    AND raw_key NOT GLOB '*..*'
    AND length(raw_key) BETWEEN 29 AND 192
  ),
  raw_sha256 TEXT NOT NULL CHECK (
    length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_content_length INTEGER NOT NULL CHECK (raw_content_length BETWEEN 2 AND 524288),
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facet_customer_approval_tenant_brand_occurred
  ON facet_customer_approval_events (tenant_id, brand_id, occurred_at DESC);

-- One global event identity prevents a producer bug from reusing an id across v1 and v2 tables.
CREATE TABLE IF NOT EXISTS facet_design_event_identity_registry (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 8 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'facet.design.approved.v1',
    'facet.design.customer_approved.v2'
  )),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  registered_at TEXT NOT NULL
);

INSERT OR IGNORE INTO facet_design_event_identity_registry
  (event_id, event_type, schema_version, registered_at)
SELECT event_id, event_type, schema_version, received_at
FROM facet_design_events;

CREATE TRIGGER IF NOT EXISTS facet_design_events_register_identity
BEFORE INSERT ON facet_design_events
BEGIN
  INSERT OR IGNORE INTO facet_design_event_identity_registry
    (event_id, event_type, schema_version, registered_at)
  VALUES (NEW.event_id, NEW.event_type, NEW.schema_version, NEW.received_at);
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM facet_design_event_identity_registry
    WHERE event_id = NEW.event_id
      AND event_type = NEW.event_type
      AND schema_version = NEW.schema_version
  ) THEN RAISE(ABORT, 'facet_design_event_identity_conflict') END;
END;

CREATE TRIGGER IF NOT EXISTS facet_customer_approval_events_register_identity
BEFORE INSERT ON facet_customer_approval_events
BEGIN
  INSERT OR IGNORE INTO facet_design_event_identity_registry
    (event_id, event_type, schema_version, registered_at)
  VALUES (NEW.event_id, NEW.event_type, NEW.schema_version, NEW.received_at);
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM facet_design_event_identity_registry
    WHERE event_id = NEW.event_id
      AND event_type = NEW.event_type
      AND schema_version = NEW.schema_version
  ) THEN RAISE(ABORT, 'facet_design_event_identity_conflict') END;
END;

CREATE TABLE IF NOT EXISTS facet_design_ingest_nonce_registry (
  nonce_hash TEXT PRIMARY KEY CHECK (
    length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL CHECK (
    length(event_id) BETWEEN 8 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'facet.design.approved.v1',
    'facet.design.customer_approved.v2'
  )),
  received_at TEXT NOT NULL
);

INSERT OR IGNORE INTO facet_design_ingest_nonce_registry
  (nonce_hash, event_id, event_type, received_at)
SELECT nonce_hash, event_id, 'facet.design.approved.v1', received_at
FROM facet_design_ingest_nonces;

CREATE TRIGGER IF NOT EXISTS facet_customer_approval_events_append_only_update
BEFORE UPDATE ON facet_customer_approval_events
BEGIN
  SELECT RAISE(ABORT, 'facet_customer_approval_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_customer_approval_events_append_only_delete
BEFORE DELETE ON facet_customer_approval_events
BEGIN
  SELECT RAISE(ABORT, 'facet_customer_approval_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_ingest_nonce_registry_append_only_update
BEFORE UPDATE ON facet_design_ingest_nonce_registry
BEGIN
  SELECT RAISE(ABORT, 'facet_design_ingest_nonce_registry_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_event_identity_registry_append_only_update
BEFORE UPDATE ON facet_design_event_identity_registry
BEGIN
  SELECT RAISE(ABORT, 'facet_design_event_identity_registry_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_event_identity_registry_append_only_delete
BEFORE DELETE ON facet_design_event_identity_registry
BEGIN
  SELECT RAISE(ABORT, 'facet_design_event_identity_registry_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_ingest_nonce_registry_append_only_delete
BEFORE DELETE ON facet_design_ingest_nonce_registry
BEGIN
  SELECT RAISE(ABORT, 'facet_design_ingest_nonce_registry_append_only');
END;
