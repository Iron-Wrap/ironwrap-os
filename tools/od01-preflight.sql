-- OD-01 pre-flight for migration 0155 (A2). Read-only: one SELECT, nothing written.
--
-- Per tenant, the open quotes and proposals whose contract terms OD-01 refuses at acceptance. Once
-- 0155 applies, a tenant with no deposit-policy revision is OD-01, and OD-01 accepts exactly one
-- contract: `deposit_percent` the integer 0 with `payment_schedule` exactly ["completion"]. This is
-- 0155's own test of the quote's terms (D1 makes a proposal bind its quote's terms hash), written
-- with IS, so a missing or mistyped term counts as refused too.
--
-- Open means the current revision (nothing supersedes it, nor, for a proposal, its quote), a quote
-- neither rejected nor expired, a job not cancelled, and no customer acceptance bound to it yet.
-- `published_proposals` counts the open proposals a customer can open now.
--
-- It reads only tables from 0090 and 0093, so it runs before 0155 exists:
--   cd workers-bus && node_modules/.bin/wrangler d1 execute ironwrap-bus --remote --env="" \
--     --file=../tools/od01-preflight.sql
-- Fixture cases: workers-bus/test/customer-contract-acceptance.test.ts ("the OD-01 pre-flight ...").
WITH refused_quote AS (
  SELECT q.tenant_id, q.quote_revision_id
    FROM commercial_quote_revisions q
    JOIN operating_roof_jobs j ON j.tenant_id = q.tenant_id AND j.roof_job_id = q.roof_job_id
   WHERE q.status IN ('draft', 'needs_review', 'approved')
     AND q.valid_until >= date('now')
     AND j.job_status != 'cancelled'
     AND NOT (
       json_type(q.terms_json, '$.deposit_percent') IS 'integer'
       AND json_extract(q.terms_json, '$.deposit_percent') IS 0
       AND json_type(q.terms_json, '$.payment_schedule') IS 'array'
       AND json_array_length(q.terms_json, '$.payment_schedule') IS 1
       AND json_extract(q.terms_json, '$.payment_schedule[0]') IS 'completion'
     )
     AND NOT EXISTS (
       SELECT 1 FROM commercial_quote_revisions successor
        WHERE successor.tenant_id = q.tenant_id
          AND successor.supersedes_quote_revision_id = q.quote_revision_id
     )
),
open_quote AS (
  SELECT r.tenant_id
    FROM refused_quote r
   WHERE NOT EXISTS (
     SELECT 1 FROM commercial_acceptance_bindings b
      WHERE b.tenant_id = r.tenant_id AND b.quote_revision_id = r.quote_revision_id
   )
),
open_proposal AS (
  SELECT p.tenant_id,
         EXISTS (
           SELECT 1 FROM commercial_proposal_publication_events e
            WHERE e.tenant_id = p.tenant_id
              AND e.proposal_pack_id = p.proposal_pack_id
              AND e.proposal_revision_id = p.proposal_revision_id
              AND e.state = 'published'
              AND e.publication_version = (
                SELECT MAX(c.publication_version) FROM commercial_proposal_publication_events c
                 WHERE c.tenant_id = e.tenant_id AND c.proposal_pack_id = e.proposal_pack_id
              )
         ) AS published
    FROM commercial_proposal_revisions p
    JOIN refused_quote r ON r.tenant_id = p.tenant_id AND r.quote_revision_id = p.quote_revision_id
   WHERE NOT EXISTS (
     SELECT 1 FROM commercial_proposal_revisions successor
      WHERE successor.tenant_id = p.tenant_id
        AND successor.supersedes_proposal_revision_id = p.proposal_revision_id
   )
     AND NOT EXISTS (
       SELECT 1 FROM commercial_acceptance_bindings b
        WHERE b.tenant_id = p.tenant_id AND b.proposal_revision_id = p.proposal_revision_id
     )
)
SELECT tenant.tenant_id,
       (SELECT COUNT(*) FROM open_quote q WHERE q.tenant_id = tenant.tenant_id) AS open_quotes,
       (SELECT COUNT(*) FROM open_proposal p WHERE p.tenant_id = tenant.tenant_id) AS open_proposals,
       (SELECT COUNT(*) FROM open_proposal p
         WHERE p.tenant_id = tenant.tenant_id AND p.published) AS published_proposals
  FROM (SELECT tenant_id FROM open_quote UNION SELECT tenant_id FROM open_proposal) tenant
 ORDER BY tenant.tenant_id;
