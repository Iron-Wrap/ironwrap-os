-- OD-01 cancellation window pre-flight for migration 0160 (A5). Read-only: one SELECT, nothing
-- written.
--
-- Per tenant, the open signed jobs whose window will read unknown once 0160 applies. Nothing before
-- 0160 records that a customer received their copy of the signed contract (no copy shown in the
-- portal, no person's record), so that is every open signed job. While a job's window is unknown,
-- it holds the job's firm start, its Materials attestation and its purchase order lines, until an
-- owner or ops person records when the copy was received:
--   POST /api/v1/production/jobs/{job}/cancellation-window/signed-copy
-- After 0160, GET /api/v1/production/cancellation-window/signed-copy-missing lists the same jobs live;
-- a job leaves the list once its time is recorded.
--
-- Open means qualified or in progress. Signed means a contract in D1 (an acceptance binding) or,
-- for a contract signed outside D1 such as a job imported from the old system, a Deposit gate that
-- has cleared. `with_d1_contract` and `signed_outside_d1` split the count.
--
-- It reads only tables from 0090 and 0093, so it runs before 0160 exists:
--   cd workers-bus && node_modules/.bin/wrangler d1 execute ironwrap-bus --remote --env="" \
--     --file=../tools/cancellation-window-preflight.sql
-- Fixture cases: workers-bus/test/customer-contract-acceptance.test.ts ("the cancellation window
-- pre-flight ...").
SELECT job.tenant_id,
       COUNT(*) AS open_signed_jobs,
       SUM(EXISTS (
         SELECT 1 FROM commercial_acceptance_bindings binding
          WHERE binding.tenant_id = job.tenant_id AND binding.roof_job_id = job.roof_job_id
       )) AS with_d1_contract,
       SUM(NOT EXISTS (
         SELECT 1 FROM commercial_acceptance_bindings binding
          WHERE binding.tenant_id = job.tenant_id AND binding.roof_job_id = job.roof_job_id
       )) AS signed_outside_d1
  FROM operating_roof_jobs job
 WHERE job.job_status IN ('qualified', 'in_progress')
   AND (
     EXISTS (
       SELECT 1 FROM commercial_acceptance_bindings binding
        WHERE binding.tenant_id = job.tenant_id AND binding.roof_job_id = job.roof_job_id
     )
     OR EXISTS (
       SELECT 1 FROM operating_production_gates deposit
        WHERE deposit.tenant_id = job.tenant_id AND deposit.roof_job_id = job.roof_job_id
          AND deposit.gate = 'Deposit' AND deposit.state != 'blocked'
     )
   )
 GROUP BY job.tenant_id
 ORDER BY job.tenant_id;
