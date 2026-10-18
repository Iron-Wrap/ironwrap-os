-- AI team earned autonomy: shadow runs, agreement records and qualification (Track A).
--
-- Shadow mode lets a specialist propose against real signals with no effect while people keep
-- doing the work: the owner switches an action into shadow for a specialist, and that action's
-- proposals are recorded here instead of as receipts, so no permit, task, handoff or effect can
-- come of them. Agreement records compare a proposal with what a person actually did, from a
-- shadow comparison or from a person's decision on an asks-first proposal, per specialist and
-- action. Qualification records name the specialist and the route (provider, model, effort) and
-- the specialist's release that the owner accepted from an evaluation report. release_sha256 is
-- the SHA-256 of the canonical JSON (keys sorted, no whitespace) of {specialist_id, playbook_sha256,
-- allowlist_sha256, common_sha256, catalog_sha256}: the hashes of the specialist's playbook.md and
-- allowlist.json, of specialists/COMMON.md, and of the contract catalog. Only an owner writes settings and qualifications; the one automatic change to
-- delegation is a demotion to asks first after a catastrophe, which only adds human control.

-- A run's mode is fixed when it opens.
ALTER TABLE agent_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'shadow'));

CREATE TRIGGER IF NOT EXISTS prevent_agent_run_mode_update
BEFORE UPDATE OF mode ON agent_runs
BEGIN
  SELECT RAISE(ABORT, 'agent_run_identity_immutable');
END;

CREATE TABLE IF NOT EXISTS agent_shadow_settings (
  setting_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  shadow INTEGER NOT NULL CHECK (shadow IN (0, 1)),
  reason TEXT NOT NULL,
  set_by_user_id TEXT NOT NULL,
  set_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (tenant_id, specialist_id, action_id, revision),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TRIGGER IF NOT EXISTS prevent_agent_shadow_setting_update
BEFORE UPDATE ON agent_shadow_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_shadow_settings_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_shadow_setting_delete
BEFORE DELETE ON agent_shadow_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_shadow_settings_append_only');
END;

CREATE TRIGGER IF NOT EXISTS agent_shadow_settings_guard
BEFORE INSERT ON agent_shadow_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_shadow_settings_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_shadow_settings s WHERE s.setting_id = NEW.setting_id
      OR (s.tenant_id = NEW.tenant_id AND s.idempotency_key = NEW.idempotency_key)
      OR (s.tenant_id = NEW.tenant_id AND s.specialist_id = NEW.specialist_id AND s.action_id = NEW.action_id AND s.revision = NEW.revision)
  );
  SELECT RAISE(ABORT, 'agent_control_authority') WHERE NOT EXISTS (
    SELECT 1 FROM app_users WHERE tenant_id = NEW.tenant_id AND user_id = NEW.set_by_user_id
      AND active = 1 AND COALESCE(access_role, role) = 'owner'
  );
END;

CREATE TABLE IF NOT EXISTS agent_shadow_steps (
  shadow_step_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs (run_id),
  specialist_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  args_json TEXT NOT NULL,
  args_sha256 TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  subject_aggregate TEXT,
  subject_id TEXT,
  proposed_at TEXT NOT NULL,
  UNIQUE (run_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_shadow_steps_pending
  ON agent_shadow_steps (tenant_id, action_id, proposed_at);

CREATE TRIGGER IF NOT EXISTS prevent_agent_shadow_step_update
BEFORE UPDATE ON agent_shadow_steps
BEGIN
  SELECT RAISE(ABORT, 'agent_shadow_steps_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_shadow_step_delete
BEFORE DELETE ON agent_shadow_steps
BEGIN
  SELECT RAISE(ABORT, 'agent_shadow_steps_append_only');
END;

CREATE TRIGGER IF NOT EXISTS agent_shadow_steps_guard
BEFORE INSERT ON agent_shadow_steps
BEGIN
  SELECT RAISE(ABORT, 'agent_shadow_steps_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_shadow_steps s WHERE s.shadow_step_id = NEW.shadow_step_id
      OR (s.run_id = NEW.run_id AND s.step_key = NEW.step_key)
  );
  SELECT RAISE(ABORT, 'agent_run_closed') WHERE NOT EXISTS (
    SELECT 1 FROM agent_runs r WHERE r.run_id = NEW.run_id AND r.tenant_id = NEW.tenant_id
      AND r.specialist_id = NEW.specialist_id AND r.state = 'open'
  );
END;

CREATE TABLE IF NOT EXISTS agent_agreements (
  agreement_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('shadow', 'decision')),
  specialist_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  shadow_step_id TEXT REFERENCES agent_shadow_steps (shadow_step_id),
  step_id TEXT REFERENCES agent_run_steps (step_id),
  verdict TEXT NOT NULL CHECK (verdict IN ('match', 'partial', 'diverge', 'unscored')),
  catastrophes_json TEXT NOT NULL,
  comparator TEXT NOT NULL,
  actual_json TEXT,
  compared_at TEXT NOT NULL,
  UNIQUE (tenant_id, shadow_step_id),
  UNIQUE (tenant_id, step_id),
  CHECK ((source = 'shadow') = (shadow_step_id IS NOT NULL)),
  CHECK ((source = 'decision') = (step_id IS NOT NULL)),
  CHECK (json_valid(catastrophes_json) AND json_type(catastrophes_json) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_agent_agreements_recent
  ON agent_agreements (tenant_id, specialist_id, action_id, compared_at);

CREATE TRIGGER IF NOT EXISTS prevent_agent_agreement_update
BEFORE UPDATE ON agent_agreements
BEGIN
  SELECT RAISE(ABORT, 'agent_agreements_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_agreement_delete
BEFORE DELETE ON agent_agreements
BEGIN
  SELECT RAISE(ABORT, 'agent_agreements_append_only');
END;

CREATE TRIGGER IF NOT EXISTS agent_agreements_guard
BEFORE INSERT ON agent_agreements
BEGIN
  SELECT RAISE(ABORT, 'agent_agreements_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_agreements a WHERE a.agreement_id = NEW.agreement_id
      OR (a.tenant_id = NEW.tenant_id AND a.shadow_step_id = NEW.shadow_step_id)
      OR (a.tenant_id = NEW.tenant_id AND a.step_id = NEW.step_id)
  );
END;

CREATE TABLE IF NOT EXISTS agent_qualifications (
  qualification_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 2 AND 31 AND provider NOT GLOB '*[^a-z0-9_]*'),
  model TEXT NOT NULL,
  effort TEXT NOT NULL CHECK (length(effort) BETWEEN 1 AND 16 AND effort NOT GLOB '*[^a-z0-9_]*'),
  release_sha256 TEXT NOT NULL CHECK (length(release_sha256) = 64 AND release_sha256 NOT GLOB '*[^0-9a-f]*'),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  report_sha256 TEXT NOT NULL CHECK (length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_by_user_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TRIGGER IF NOT EXISTS prevent_agent_qualification_update
BEFORE UPDATE ON agent_qualifications
BEGIN
  SELECT RAISE(ABORT, 'agent_qualifications_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_qualification_delete
BEFORE DELETE ON agent_qualifications
BEGIN
  SELECT RAISE(ABORT, 'agent_qualifications_append_only');
END;

CREATE TRIGGER IF NOT EXISTS agent_qualifications_guard
BEFORE INSERT ON agent_qualifications
BEGIN
  SELECT RAISE(ABORT, 'agent_qualifications_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_qualifications q WHERE q.qualification_id = NEW.qualification_id
      OR (q.tenant_id = NEW.tenant_id AND q.idempotency_key = NEW.idempotency_key)
  );
  SELECT RAISE(ABORT, 'agent_control_authority') WHERE NOT EXISTS (
    SELECT 1 FROM app_users WHERE tenant_id = NEW.tenant_id AND user_id = NEW.recorded_by_user_id
      AND active = 1 AND COALESCE(access_role, role) = 'owner'
  );
END;

-- The owner sets delegation; the only other writer is the automatic demotion to asks first after
-- a catastrophe, which may only replace a within-limits setting.
DROP TRIGGER IF EXISTS agent_delegation_owner_guard;

CREATE TRIGGER IF NOT EXISTS agent_delegation_owner_guard
BEFORE INSERT ON agent_delegation_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_control_authority') WHERE NOT (
    EXISTS (
      SELECT 1 FROM app_users WHERE tenant_id = NEW.tenant_id AND user_id = NEW.set_by_user_id
        AND active = 1 AND COALESCE(access_role, role) = 'owner'
    )
    OR (
      NEW.set_by_user_id = 'system:auto_demotion' AND NEW.setting = 'asks_first'
      AND COALESCE((SELECT setting FROM agent_delegation_settings WHERE tenant_id = NEW.tenant_id
             AND specialist_id = NEW.specialist_id AND action_id = NEW.action_id
             ORDER BY revision DESC LIMIT 1), '') = 'within_limits'
    )
  );
END;
