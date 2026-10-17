-- D1 cannot transact with R2. Each cold-upload attempt keeps a durable claim
-- across every provider await. Disposal may begin only after all writers settle.
-- An interrupted or ambiguous writer is never expired, stolen, or auto-cleared.
CREATE TABLE evidence_upload_write_claims (
  claim_id TEXT PRIMARY KEY CHECK (length(claim_id) = 40
    AND claim_id GLOB 'ewc_????????-????-????-????-????????????'
    AND replace(substr(claim_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'),
  tenant_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) = 68 AND receipt_id GLOB 'evu_*'
    AND substr(receipt_id, 5) NOT GLOB '*[^0-9a-f]*'),
  actor_user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  r2_key TEXT NOT NULL CHECK (r2_key = 'evidence/v1/' || substr(receipt_id, 5) || '.bin'),
  started_at TEXT NOT NULL,
  last_transition_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'unknown', 'settled')),
  failure_code TEXT,
  settled_at TEXT,
  CHECK ((state = 'active' AND failure_code IS NULL AND settled_at IS NULL)
    OR (state = 'unknown' AND failure_code = 'raw_put_outcome_unknown' AND settled_at IS NULL)
    OR (state = 'settled' AND failure_code IS NULL AND settled_at IS NOT NULL))
);
CREATE INDEX evidence_upload_write_claim_lookup
  ON evidence_upload_write_claims(tenant_id, receipt_id, state, claim_id);

CREATE TRIGGER evidence_upload_write_claim_insert_guard BEFORE INSERT ON evidence_upload_write_claims
WHEN NEW.state != 'active' OR NEW.last_transition_at IS NOT NEW.started_at
  OR EXISTS (SELECT 1 FROM evidence_upload_write_claims WHERE claim_id = NEW.claim_id)
  OR NOT EXISTS (SELECT 1 FROM app_users WHERE tenant_id = NEW.tenant_id
    AND user_id = NEW.actor_user_id AND active = 1)
  OR EXISTS (SELECT 1 FROM evidence_upload_dispositions WHERE receipt_id = NEW.receipt_id)
  OR EXISTS (SELECT 1 FROM evidence_upload_receipts WHERE receipt_id = NEW.receipt_id
    AND (tenant_id IS NOT NEW.tenant_id OR actor_user_id IS NOT NEW.actor_user_id
      OR request_sha256 IS NOT NEW.request_sha256 OR r2_key IS NOT NEW.r2_key))
  OR EXISTS (SELECT 1 FROM evidence_upload_write_claims WHERE receipt_id = NEW.receipt_id
    AND (tenant_id IS NOT NEW.tenant_id OR actor_user_id IS NOT NEW.actor_user_id
      OR request_sha256 IS NOT NEW.request_sha256 OR r2_key IS NOT NEW.r2_key OR state = 'unknown'))
BEGIN SELECT RAISE(ABORT, 'evidence_upload_write_claim_invalid'); END;

CREATE TRIGGER evidence_upload_write_claim_transition_guard BEFORE UPDATE ON evidence_upload_write_claims
WHEN NEW.claim_id IS NOT OLD.claim_id OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.receipt_id IS NOT OLD.receipt_id OR NEW.actor_user_id IS NOT OLD.actor_user_id
  OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.r2_key IS NOT OLD.r2_key
  OR NEW.started_at IS NOT OLD.started_at OR OLD.state != 'active'
  OR NEW.state NOT IN ('unknown', 'settled')
BEGIN SELECT RAISE(ABORT, 'evidence_upload_write_claim_transition_invalid'); END;

CREATE TRIGGER evidence_upload_write_claim_immutable_delete BEFORE DELETE ON evidence_upload_write_claims
BEGIN SELECT RAISE(ABORT, 'evidence_upload_write_claim_immutable'); END;

CREATE TRIGGER evidence_upload_disposition_write_claim_insert_guard BEFORE INSERT ON evidence_upload_dispositions
WHEN EXISTS (SELECT 1 FROM evidence_upload_write_claims WHERE tenant_id = NEW.tenant_id
  AND receipt_id = NEW.receipt_id AND state != 'settled')
BEGIN SELECT RAISE(ABORT, 'evidence_upload_write_pending'); END;

CREATE TRIGGER evidence_upload_disposition_write_claim_transition_guard BEFORE UPDATE ON evidence_upload_dispositions
WHEN NEW.state IN ('destroying', 'destroyed')
  AND EXISTS (SELECT 1 FROM evidence_upload_write_claims WHERE tenant_id = NEW.tenant_id
    AND receipt_id = NEW.receipt_id AND state != 'settled')
BEGIN SELECT RAISE(ABORT, 'evidence_upload_write_pending'); END;
