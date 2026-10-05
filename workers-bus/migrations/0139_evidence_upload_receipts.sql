-- Raw bytes are written and verified in R2 before these immutable tenant-scoped receipts.
CREATE TABLE evidence_upload_receipts (
  receipt_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  upload_key_sha256 TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('stock', 'service_intake', 'service_step', 'corrective_action')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, actor_user_id, upload_key_sha256),
  FOREIGN KEY (actor_user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);
CREATE INDEX evidence_upload_scope ON evidence_upload_receipts(tenant_id, purpose, target_id, action, operation_id);
CREATE TRIGGER evidence_upload_receipt_immutable_update BEFORE UPDATE ON evidence_upload_receipts
BEGIN SELECT RAISE(ABORT, 'evidence_receipt_immutable'); END;
CREATE TRIGGER evidence_upload_receipt_immutable_delete BEFORE DELETE ON evidence_upload_receipts
BEGIN SELECT RAISE(ABORT, 'evidence_receipt_immutable'); END;
CREATE TRIGGER evidence_upload_receipt_immutable_replace BEFORE INSERT ON evidence_upload_receipts
WHEN EXISTS (SELECT 1 FROM evidence_upload_receipts WHERE receipt_id = NEW.receipt_id OR r2_key = NEW.r2_key OR
  (tenant_id = NEW.tenant_id AND actor_user_id = NEW.actor_user_id AND upload_key_sha256 = NEW.upload_key_sha256))
BEGIN SELECT RAISE(ABORT, 'evidence_receipt_immutable'); END;

-- Service digest fields point to a server-derived manifest, never a browser-supplied hash.
CREATE TABLE evidence_upload_manifests (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  refs_json TEXT NOT NULL CHECK (json_valid(refs_json)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER evidence_upload_manifest_immutable_update BEFORE UPDATE ON evidence_upload_manifests
BEGIN SELECT RAISE(ABORT, 'evidence_manifest_immutable'); END;
CREATE TRIGGER evidence_upload_manifest_immutable_delete BEFORE DELETE ON evidence_upload_manifests
BEGIN SELECT RAISE(ABORT, 'evidence_manifest_immutable'); END;
CREATE TRIGGER evidence_upload_manifest_immutable_replace BEFORE INSERT ON evidence_upload_manifests
WHEN EXISTS (SELECT 1 FROM evidence_upload_manifests WHERE sha256 = NEW.sha256)
BEGIN SELECT RAISE(ABORT, 'evidence_manifest_immutable'); END;

ALTER TABLE service_cases ADD COLUMN intake_request_sha256 TEXT CHECK (
  intake_request_sha256 IS NULL OR (length(intake_request_sha256) = 64 AND intake_request_sha256 NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER service_case_intake_request_immutable BEFORE UPDATE OF intake_request_sha256 ON service_cases
WHEN NEW.intake_request_sha256 IS NOT OLD.intake_request_sha256
BEGIN SELECT RAISE(ABORT, 'service_case_intake_request_immutable'); END;
