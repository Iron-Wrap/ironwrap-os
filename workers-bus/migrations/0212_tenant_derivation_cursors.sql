-- 0212_tenant_derivation_cursors.sql
-- Each tenant's deposit-gate and final-invoice derivation walks behind its own cursor row, named
-- `scheduled-v1:<tenant>`, so a registry tenant no longer waits on the Worker's one row. The
-- CHECK ties that name to the row's tenant. The columns and the `scheduled-v1` row are kept for a
-- rolled-back Worker, whose reads and upserts still apply; the current position is copied to the
-- tenant it last stood on. Rows pass through a staging table because ALTER TABLE RENAME re-parses
-- every trigger in the schema.
CREATE TABLE commercial_deposit_derivation_cursors_prior AS
  SELECT cursor_name, last_tenant_id, last_acceptance_id, updated_at
    FROM commercial_deposit_derivation_cursors;
DROP TABLE commercial_deposit_derivation_cursors;
CREATE TABLE commercial_deposit_derivation_cursors (
  cursor_name TEXT PRIMARY KEY CHECK (
    cursor_name = 'scheduled-v1'
    OR (cursor_name GLOB 'scheduled-v1:*' AND substr(cursor_name, 14) = last_tenant_id)
  ),
  last_tenant_id TEXT NOT NULL CHECK (
    length(last_tenant_id) BETWEEN 2 AND 64
    AND last_tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  last_acceptance_id TEXT NOT NULL CHECK (length(last_acceptance_id) BETWEEN 16 AND 100),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
);
INSERT INTO commercial_deposit_derivation_cursors
  SELECT cursor_name, last_tenant_id, last_acceptance_id, updated_at
    FROM commercial_deposit_derivation_cursors_prior;
INSERT INTO commercial_deposit_derivation_cursors
  SELECT 'scheduled-v1:' || last_tenant_id, last_tenant_id, last_acceptance_id, updated_at
    FROM commercial_deposit_derivation_cursors_prior;
DROP TABLE commercial_deposit_derivation_cursors_prior;

CREATE TABLE native_final_invoice_derivation_cursors_prior AS
  SELECT cursor_name, last_tenant_id, last_roof_job_id, updated_at
    FROM native_final_invoice_derivation_cursors;
DROP TABLE native_final_invoice_derivation_cursors;
CREATE TABLE native_final_invoice_derivation_cursors (
  cursor_name TEXT PRIMARY KEY CHECK (
    cursor_name = 'scheduled-v1'
    OR (cursor_name GLOB 'scheduled-v1:*' AND substr(cursor_name, 14) = last_tenant_id)
  ),
  last_tenant_id TEXT NOT NULL CHECK (
    length(last_tenant_id) BETWEEN 2 AND 64
    AND last_tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  last_roof_job_id TEXT NOT NULL CHECK (length(last_roof_job_id) BETWEEN 1 AND 160),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
);
INSERT INTO native_final_invoice_derivation_cursors
  SELECT cursor_name, last_tenant_id, last_roof_job_id, updated_at
    FROM native_final_invoice_derivation_cursors_prior;
INSERT INTO native_final_invoice_derivation_cursors
  SELECT 'scheduled-v1:' || last_tenant_id, last_tenant_id, last_roof_job_id, updated_at
    FROM native_final_invoice_derivation_cursors_prior;
DROP TABLE native_final_invoice_derivation_cursors_prior;
