-- 0030_facet_design_ingest.sql - Facet-approved design receipts, before any operating projection.
--
-- Raw signed JSON is retained in R2 first. D1 holds immutable anchors only: there is no quote,
-- proposal, contract, customer acceptance, or Frappe side effect in this ingress boundary.
-- tenant_id is the configured local IronWrap tenant; the Facet source tenant remains in signed R2.

CREATE TABLE IF NOT EXISTS facet_design_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 8 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  event_type TEXT NOT NULL CHECK (event_type = 'facet.design.approved.v1'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 24 AND 40),
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
    length(design_revision_sha256) = 64 AND design_revision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  frozen_evidence_sha256 TEXT NOT NULL CHECK (
    length(frozen_evidence_sha256) = 64 AND frozen_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_key TEXT NOT NULL UNIQUE CHECK (
    raw_key GLOB 'facet-design/v1/*'
    AND raw_key NOT GLOB '*..*'
    AND length(raw_key) BETWEEN 29 AND 192
  ),
  raw_sha256 TEXT NOT NULL CHECK (
    length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_content_length INTEGER NOT NULL CHECK (raw_content_length BETWEEN 2 AND 524288),
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facet_design_events_tenant_project_occurred
  ON facet_design_events (tenant_id, facet_project_id, occurred_at DESC);

-- The nonce is hashed before D1. It is append-only so a valid signed request cannot be replayed
-- with the same freshness window, even if the event id is changed.
CREATE TABLE IF NOT EXISTS facet_design_ingest_nonces (
  nonce_hash TEXT PRIMARY KEY CHECK (
    length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'
  ),
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES facet_design_events(event_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS facet_design_events_append_only_update
BEFORE UPDATE ON facet_design_events
BEGIN
  SELECT RAISE(ABORT, 'facet_design_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_events_append_only_delete
BEFORE DELETE ON facet_design_events
BEGIN
  SELECT RAISE(ABORT, 'facet_design_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_ingest_nonces_append_only_update
BEFORE UPDATE ON facet_design_ingest_nonces
BEGIN
  SELECT RAISE(ABORT, 'facet_design_ingest_nonces_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_design_ingest_nonces_append_only_delete
BEFORE DELETE ON facet_design_ingest_nonces
BEGIN
  SELECT RAISE(ABORT, 'facet_design_ingest_nonces_append_only');
END;
