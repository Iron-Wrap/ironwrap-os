-- 0109_crm_import_ledger.sql - module-owned ledger for importing an existing CRM export into a
-- tenant (ELEC-166).
--
-- The importer owns nothing in the operating core: contacts, jobs and estimates are materialized
-- through the ordinary envelope -> operating-core path so an imported record is indistinguishable
-- from an ingested one. These three tables hold only what the import itself is accountable for:
--
--   crm_import_runs     one row per executed run, carrying the reconciliation report verbatim.
--   crm_import_records  the idempotency key and the board placement for one source opportunity.
--   crm_import_issues   every capped, archived, dropped or failed disposition, queryable rather
--                       than buried in a log.
--
-- Pipeline stage placement is recorded as a stage KEY string, not a foreign key into a pipeline
-- table. The board (M1 pipeline v1) owns pipelines and stages; this module writes the placement it
-- can honestly derive from the source and the board reads it by key. Expand-only: no core table is
-- altered here.

CREATE TABLE IF NOT EXISTS crm_import_runs (
  run_id TEXT PRIMARY KEY CHECK (
    length(run_id) BETWEEN 8 AND 200
    AND run_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  adapter TEXT NOT NULL CHECK (length(trim(adapter)) BETWEEN 1 AND 64),
  pipeline_key TEXT NOT NULL CHECK (
    length(pipeline_key) BETWEEN 1 AND 64
    AND pipeline_key NOT GLOB '*[^a-z0-9_-]*'
  ),
  source_label TEXT CHECK (source_label IS NULL OR length(trim(source_label)) BETWEEN 1 AND 200),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
  source_row_count INTEGER NOT NULL CHECK (
    typeof(source_row_count) = 'integer' AND source_row_count BETWEEN 0 AND 1000000
  ),
  report_json TEXT NOT NULL CHECK (length(report_json) BETWEEN 2 AND 4000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (run_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_import_runs_tenant_time
  ON crm_import_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_import_records (
  import_record_id TEXT PRIMARY KEY CHECK (
    length(import_record_id) BETWEEN 8 AND 240
    AND import_record_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  adapter TEXT NOT NULL CHECK (length(trim(adapter)) BETWEEN 1 AND 64),
  import_key TEXT NOT NULL CHECK (length(trim(import_key)) BETWEEN 1 AND 240),
  first_run_id TEXT NOT NULL,
  last_run_id TEXT NOT NULL,
  source_envelope_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  pipeline_key TEXT NOT NULL CHECK (
    length(pipeline_key) BETWEEN 1 AND 64
    AND pipeline_key NOT GLOB '*[^a-z0-9_-]*'
  ),
  stage_key TEXT NOT NULL CHECK (
    length(stage_key) BETWEEN 1 AND 64
    AND stage_key NOT GLOB '*[^a-z0-9_-]*'
  ),
  source_stage TEXT CHECK (source_stage IS NULL OR length(trim(source_stage)) BETWEEN 1 AND 120),
  placement_verdict TEXT NOT NULL CHECK (
    placement_verdict IN ('direct', 'capped', 'unmapped_default')
  ),
  source_lead_number TEXT CHECK (
    source_lead_number IS NULL OR length(trim(source_lead_number)) BETWEEN 1 AND 120
  ),
  source_value_cents INTEGER CHECK (
    source_value_cents IS NULL
    OR (typeof(source_value_cents) = 'integer' AND source_value_cents >= 0)
  ),
  value_disposition TEXT NOT NULL CHECK (value_disposition IN ('placed', 'archived', 'absent')),
  row_digest TEXT NOT NULL CHECK (length(row_digest) = 64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, import_key),
  UNIQUE (tenant_id, roof_job_id),
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id) REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_crm_import_records_tenant_stage
  ON crm_import_records (tenant_id, pipeline_key, stage_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_import_records_run
  ON crm_import_records (tenant_id, last_run_id);

CREATE TABLE IF NOT EXISTS crm_import_issues (
  issue_id TEXT PRIMARY KEY CHECK (
    length(issue_id) BETWEEN 8 AND 240
    AND issue_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  run_id TEXT NOT NULL,
  import_key TEXT CHECK (import_key IS NULL OR length(trim(import_key)) BETWEEN 1 AND 240),
  kind TEXT NOT NULL CHECK (
    kind IN ('stage_capped', 'stage_unmapped', 'value_archived', 'field_archived', 'field_dropped', 'row_error')
  ),
  field TEXT CHECK (field IS NULL OR length(trim(field)) BETWEEN 1 AND 120),
  detail TEXT NOT NULL CHECK (length(trim(detail)) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  FOREIGN KEY (run_id) REFERENCES crm_import_runs(run_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_crm_import_issues_run
  ON crm_import_issues (tenant_id, run_id, kind);
