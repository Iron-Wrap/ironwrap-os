-- 0112_operator_search_prefix_indexes.sql - index support for the operator search-and-jump
-- endpoint (`GET /api/v1/search`, `workers-bus/src/app-search.ts`).
--
-- No new table and no new fact. The palette reads the existing operating-core registers; these
-- indexes only make the reads it issues on every keystroke a bounded seek instead of a tenant
-- table scan.
--
-- Why NOCASE. The endpoint matches a case-insensitive prefix with a plain `LIKE 'text%'` and no
-- ESCAPE clause -- the query normalizer removes `%` and `_` before the pattern is built, so no
-- ESCAPE is needed, and adding one would disable the optimization outright. SQLite applies its
-- LIKE optimization (rewriting `x LIKE 'abc%'` into a `>= 'abc' AND < 'abd'` range) only when
-- `case_sensitive_like` is off -- the default -- AND the column is indexed with the built-in
-- NOCASE collation. The existing BINARY indexes on these tables therefore cannot serve the
-- palette, which is why these are additional indexes rather than replacements.
--
-- Each index also carries the ORDER BY the endpoint uses (`<column> COLLATE NOCASE ASC`), so the
-- bounded page is produced by walking the index and stopping, with no sort step.
--
-- Additive and expand-only: no shipped migration is touched, no column changes, no data is
-- rewritten, and dropping these indexes would slow the palette down without changing any answer.

-- Jobs are addressed by job number.
CREATE INDEX IF NOT EXISTS idx_operating_roof_jobs_tenant_job_number_search
  ON operating_roof_jobs (tenant_id, job_number COLLATE NOCASE);

-- The customer group admits a customer only when it owns an openable active job, and links to
-- that job. Both the EXISTS filter and the scalar lookup key on (tenant_id, customer_id); the
-- foreign key alone does not create an index in SQLite, so without this each candidate customer
-- would scan the job table.
CREATE INDEX IF NOT EXISTS idx_operating_roof_jobs_tenant_customer_status
  ON operating_roof_jobs (tenant_id, customer_id, job_status);

-- Leads are addressed by contact name, phone, or email, one column per query class.
CREATE INDEX IF NOT EXISTS idx_operating_leads_tenant_contact_name_search
  ON operating_leads (tenant_id, contact_name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_operating_leads_tenant_contact_phone_search
  ON operating_leads (tenant_id, contact_phone COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_operating_leads_tenant_contact_email_search
  ON operating_leads (tenant_id, contact_email COLLATE NOCASE);

-- Customers are addressed by display name or phone. Email is deliberately not indexed here: the
-- endpoint neither matches nor returns a customer email, because the job packet that authorizes
-- this group does not expose one.
CREATE INDEX IF NOT EXISTS idx_operating_customers_tenant_display_name_search
  ON operating_customers (tenant_id, display_name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_operating_customers_tenant_contact_phone_search
  ON operating_customers (tenant_id, contact_phone COLLATE NOCASE);
