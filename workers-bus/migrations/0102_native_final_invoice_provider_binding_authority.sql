-- 0102_native_final_invoice_provider_binding_authority.sql
--
-- A QuickBooks mapping is valid only for the exact customer-accepted commercial head that was
-- provider-verified. Historical 0079 rows remain readable as provenance, but their NULL anchors
-- are deliberately unusable until an owner records a new verified mapping.

ALTER TABLE native_final_invoice_provider_bindings
  ADD COLUMN commercial_terms_hash TEXT CHECK (
    commercial_terms_hash IS NULL OR (
      length(commercial_terms_hash) = 64
      AND commercial_terms_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE native_final_invoice_provider_bindings
  ADD COLUMN commercial_head_sha256 TEXT CHECK (
    commercial_head_sha256 IS NULL OR (
      length(commercial_head_sha256) = 64
      AND commercial_head_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE UNIQUE INDEX idx_native_final_invoice_provider_bindings_source_ref
  ON native_final_invoice_provider_bindings (tenant_id, roof_job_id, source_ref)
  WHERE commercial_terms_hash IS NOT NULL AND commercial_head_sha256 IS NOT NULL;

CREATE TRIGGER native_final_invoice_provider_bindings_require_commercial_anchor
BEFORE INSERT ON native_final_invoice_provider_bindings
WHEN NEW.commercial_terms_hash IS NULL OR NEW.commercial_head_sha256 IS NULL
BEGIN
  SELECT RAISE(ABORT, 'native_final_invoice_provider_binding_commercial_anchor_required');
END;
