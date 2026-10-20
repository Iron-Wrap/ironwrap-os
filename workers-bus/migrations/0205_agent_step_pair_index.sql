-- AI team: one specialist's steps of one action (Track A, AI-TEAM-CONTRACT.md "Delegation").
--
-- The delegation record, the decision history, the within-limits count per window and the
-- delegation fallback read one specialist's steps of one action. Without this index each of those
-- reads scans every step of the tenant (idx_agent_run_steps_tenant_open leads with outcome).

CREATE INDEX IF NOT EXISTS idx_agent_run_steps_pair
  ON agent_run_steps (tenant_id, specialist_id, action_id, created_at);
