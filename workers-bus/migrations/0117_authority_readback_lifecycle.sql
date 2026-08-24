-- 0117_authority_readback_lifecycle.sql
--
-- Persist the lifecycle facts that downstream gates must re-evaluate from D1
-- without re-reading mutable Frappe rows.

ALTER TABLE authority_record_readbacks ADD COLUMN authority_effective_from TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN authority_expires_at TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN authority_revoked_at TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN supersedes_authority_record_id TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN authority_verification_method TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN issuer_receipt_sha256 TEXT;

CREATE TRIGGER IF NOT EXISTS authority_record_readbacks_lifecycle_insert_guard
BEFORE INSERT ON authority_record_readbacks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'authority_record_readbacks_lifecycle_date_invalid')
    WHERE NEW.authority_effective_from IS NOT NULL AND (
      NEW.authority_effective_from NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR
      strftime('%Y-%m-%d', NEW.authority_effective_from) != NEW.authority_effective_from
    );
  SELECT RAISE(ABORT, 'authority_record_readbacks_lifecycle_date_invalid')
    WHERE NEW.authority_expires_at IS NOT NULL AND (
      NEW.authority_expires_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR
      strftime('%Y-%m-%d', NEW.authority_expires_at) != NEW.authority_expires_at
    );
  SELECT RAISE(ABORT, 'authority_record_readbacks_lifecycle_instant_invalid')
    WHERE NEW.authority_revoked_at IS NOT NULL AND NOT (
      (
        NEW.authority_revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z' AND
        strftime('%Y-%m-%dT%H:%M:%SZ', NEW.authority_revoked_at) = NEW.authority_revoked_at
      ) OR (
        NEW.authority_revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', NEW.authority_revoked_at) = NEW.authority_revoked_at
      )
    );
  SELECT RAISE(ABORT, 'authority_record_readbacks_lifecycle_range_invalid')
    WHERE NEW.authority_effective_from IS NOT NULL
      AND NEW.authority_expires_at IS NOT NULL
      AND NEW.authority_effective_from > NEW.authority_expires_at;
  SELECT RAISE(ABORT, 'authority_record_readbacks_supersedes_self')
    WHERE NEW.supersedes_authority_record_id IS NOT NULL
      AND NEW.supersedes_authority_record_id = NEW.authority_record_id;
  SELECT RAISE(ABORT, 'authority_record_readbacks_supersedes_invalid')
    WHERE NEW.supersedes_authority_record_id IS NOT NULL AND (
      length(NEW.supersedes_authority_record_id) < 3 OR
      length(NEW.supersedes_authority_record_id) > 140 OR
      substr(NEW.supersedes_authority_record_id, 1, 1) NOT GLOB '[A-Za-z0-9]' OR
      length(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(
          NEW.supersedes_authority_record_id,
          'A', ''), 'B', ''), 'C', ''), 'D', ''), 'E', ''), 'F', ''), 'G', ''), 'H', ''), 'I', ''), 'J', ''),
          'K', ''), 'L', ''), 'M', ''), 'N', ''), 'O', ''), 'P', ''), 'Q', ''), 'R', ''), 'S', ''), 'T', ''),
          'U', ''), 'V', ''), 'W', ''), 'X', ''), 'Y', ''), 'Z', ''), 'a', ''), 'b', ''), 'c', ''), 'd', ''),
          'e', ''), 'f', ''), 'g', ''), 'h', ''), 'i', ''), 'j', ''), 'k', ''), 'l', ''), 'm', ''), 'n', ''),
          'o', ''), 'p', ''), 'q', ''), 'r', ''), 's', ''), 't', ''), 'u', ''), 'v', ''), 'w', ''), 'x', ''),
          'y', ''), 'z', ''), '0', ''), '1', ''), '2', ''), '3', ''), '4', ''), '5', ''), '6', ''), '7', ''),
          '8', ''), '9', ''), '.', ''), '_', ''), ':', ''), '-', '')
      ) != 0
    );
  SELECT RAISE(ABORT, 'authority_record_readbacks_receipt_sha_invalid')
    WHERE NEW.issuer_receipt_sha256 IS NOT NULL AND (
      length(NEW.issuer_receipt_sha256) != 64 OR
      length(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(
          lower(NEW.issuer_receipt_sha256),
          '0', ''), '1', ''), '2', ''), '3', ''), '4', ''), '5', ''), '6', ''), '7', ''), '8', ''), '9', ''),
          'a', ''), 'b', ''), 'c', ''), 'd', ''), 'e', ''), 'f', '')
      ) != 0
    );
END;

CREATE INDEX IF NOT EXISTS idx_authority_record_readbacks_binding
  ON authority_record_readbacks (
    tenant_id,
    subject_type,
    subject_role,
    person_user,
    organization,
    authority_kind,
    authority_scope,
    scope_type,
    scope_ref,
    roof_job,
    issuer_reference,
    issuer_source_version,
    issuer_jurisdiction,
    authority_version DESC,
    observed_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_authority_record_readbacks_supersedes
  ON authority_record_readbacks (
    tenant_id,
    supersedes_authority_record_id,
    authority_version DESC,
    observed_at DESC
  );
