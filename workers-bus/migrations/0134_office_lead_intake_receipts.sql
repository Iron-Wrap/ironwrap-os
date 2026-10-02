-- Office intake receipts bind one immutable request to one native ingestion identity.
-- 0132 and 0133 are reserved by the independent pairing/communications slices.
CREATE TABLE office_lead_intake_receipts (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK(length(request_id) = 48 AND request_id LIKE 'office-lead:%'),
  actor_user_id TEXT NOT NULL CHECK(length(actor_user_id) BETWEEN 1 AND 160),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  envelope_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  consent_jurisdiction TEXT CHECK(consent_jurisdiction IS NULL OR length(consent_jurisdiction) BETWEEN 2 AND 120),
  consent_wording_version TEXT,
  state TEXT NOT NULL DEFAULT 'processing' CHECK(state IN ('processing','recorded')),
  outcome TEXT CHECK(outcome IN ('created','duplicate')),
  canonical_envelope_id TEXT,
  PRIMARY KEY (tenant_id, request_id),
  UNIQUE (tenant_id, envelope_id),
  CHECK ((state = 'processing' AND outcome IS NULL AND canonical_envelope_id IS NULL)
    OR (state = 'recorded' AND outcome IS NOT NULL AND canonical_envelope_id IS NOT NULL)),
  CHECK (outcome IS NOT 'created' OR canonical_envelope_id = envelope_id),
  CHECK (outcome IS NOT 'duplicate' OR canonical_envelope_id <> envelope_id)
);
CREATE INDEX idx_office_lead_intake_receipts_envelope
  ON office_lead_intake_receipts (tenant_id, envelope_id);
CREATE TRIGGER office_lead_intake_receipts_immutable
BEFORE UPDATE ON office_lead_intake_receipts
WHEN OLD.state = 'recorded' OR NEW.state <> 'recorded'
 OR OLD.tenant_id IS NOT NEW.tenant_id OR OLD.request_id IS NOT NEW.request_id
 OR OLD.actor_user_id IS NOT NEW.actor_user_id OR OLD.request_hash IS NOT NEW.request_hash
 OR OLD.envelope_id IS NOT NEW.envelope_id OR OLD.captured_at IS NOT NEW.captured_at
 OR OLD.input_json IS NOT NEW.input_json OR OLD.payload_json IS NOT NEW.payload_json
 OR OLD.payload_sha256 IS NOT NEW.payload_sha256
 OR OLD.consent_jurisdiction IS NOT NEW.consent_jurisdiction
 OR OLD.consent_wording_version IS NOT NEW.consent_wording_version
BEGIN SELECT RAISE(ABORT, 'office_lead_intake_receipt_immutable'); END;
CREATE TRIGGER office_lead_intake_receipts_no_delete
BEFORE DELETE ON office_lead_intake_receipts
BEGIN SELECT RAISE(ABORT, 'office_lead_intake_receipt_immutable'); END;
CREATE TRIGGER office_lead_intake_receipts_no_replace
BEFORE INSERT ON office_lead_intake_receipts
WHEN EXISTS (SELECT 1 FROM office_lead_intake_receipts
 WHERE tenant_id = NEW.tenant_id AND (request_id = NEW.request_id OR envelope_id = NEW.envelope_id))
BEGIN SELECT RAISE(ABORT, 'office_lead_intake_receipt_immutable'); END;
CREATE TRIGGER office_lead_intake_receipts_canonical_guard
BEFORE UPDATE ON office_lead_intake_receipts
WHEN NOT EXISTS (SELECT 1 FROM envelopes WHERE tenant_id = NEW.tenant_id AND envelope_id = NEW.canonical_envelope_id)
BEGIN SELECT RAISE(ABORT, 'office_lead_intake_canonical_missing'); END;
