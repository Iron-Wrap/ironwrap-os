-- 0015_lead_ack_receipts.sql - immutable provider-acceptance evidence for the first-touch SLA.
-- This table records only a provider receipt or an attempted/no-channel outcome. It never claims
-- delivery to a homeowner, and it deliberately stores no recipient address or message body.

CREATE TABLE IF NOT EXISTS lead_ack_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) BETWEEN 12 AND 80
    AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  envelope_id TEXT NOT NULL REFERENCES envelopes(envelope_id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'none')),
  outcome TEXT NOT NULL CHECK (outcome IN ('provider_accepted', 'attempt_failed', 'no_eligible_channel')),
  observed_at TEXT NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (outcome = 'provider_accepted' AND channel = 'email' AND provider_message_id IS NOT NULL AND error_code IS NULL)
    OR (outcome = 'attempt_failed' AND channel = 'email' AND provider_message_id IS NULL AND error_code IS NOT NULL)
    OR (outcome = 'no_eligible_channel' AND channel = 'none' AND provider_message_id IS NULL AND error_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lead_ack_receipts_envelope_observed
  ON lead_ack_receipts (envelope_id, observed_at, receipt_id);

-- Receipt evidence is append-only. Correct an upstream problem with a new outcome/audit event;
-- never rewrite or erase the provider fact that informed the original MCTB decision.
CREATE TRIGGER IF NOT EXISTS prevent_lead_ack_receipts_update
BEFORE UPDATE ON lead_ack_receipts
BEGIN
  SELECT RAISE(ABORT, 'lead_ack_receipts_immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_lead_ack_receipts_delete
BEFORE DELETE ON lead_ack_receipts
BEGIN
  SELECT RAISE(ABORT, 'lead_ack_receipts_immutable');
END;
