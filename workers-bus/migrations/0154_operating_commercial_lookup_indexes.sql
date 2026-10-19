-- 0154_operating_commercial_lookup_indexes.sql - lookups the owner brief and the job read model
-- make per lead and per job, which today search the whole tenant.
--
-- A lead's jobs, a job's deposit derivation, and the "current revision" checks (no successor
-- supersedes this revision) each used an index keyed on tenant_id alone. Indexes only: no table,
-- no trigger, no data change.

CREATE INDEX IF NOT EXISTS idx_operating_roof_jobs_tenant_lead
  ON operating_roof_jobs (tenant_id, lead_id);

CREATE INDEX IF NOT EXISTS idx_commercial_deposit_derivations_tenant_job
  ON commercial_deposit_derivations (tenant_id, roof_job_id);

CREATE INDEX IF NOT EXISTS idx_commercial_quotes_supersedes
  ON commercial_quote_revisions (tenant_id, supersedes_quote_revision_id);

CREATE INDEX IF NOT EXISTS idx_commercial_proposals_supersedes
  ON commercial_proposal_revisions (tenant_id, supersedes_proposal_revision_id);
