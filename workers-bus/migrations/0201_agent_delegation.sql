-- AI team delegation and decisions (Track A, AI-TEAM-CONTRACT.md "Delegation", "Receipts",
-- "Escalation to a named person").
--
-- Delegation settings and specialist controls are append-only revisions: the current value is the
-- highest revision, and every change keeps who made it and when. Only an owner session writes a
-- setting or clears a hold; the auditor's protective `specialist.hold` sets one. A decision on a
-- step that asks first binds the exact step version and argument hash and is recorded once.
-- Exceptions name the role a person acts in and are acknowledged, never deleted.

CREATE TABLE IF NOT EXISTS agent_delegation_settings (
  setting_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  control_revision INTEGER NOT NULL CHECK (control_revision >= 0),
  catalog_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  setting TEXT NOT NULL CHECK (setting IN ('asks_first', 'within_limits', 'off')),
  ceiling_json TEXT,
  reason TEXT NOT NULL,
  set_by_user_id TEXT NOT NULL,
  set_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (tenant_id, specialist_id, action_id, revision),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((setting = 'within_limits') = (ceiling_json IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_delegation_current
  ON agent_delegation_settings (tenant_id, specialist_id, action_id, revision);

CREATE TRIGGER IF NOT EXISTS prevent_agent_delegation_update
BEFORE UPDATE ON agent_delegation_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_delegation_settings_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_delegation_delete
BEFORE DELETE ON agent_delegation_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_delegation_settings_append_only');
END;

CREATE TABLE IF NOT EXISTS agent_specialist_controls (
  control_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  held INTEGER NOT NULL CHECK (held IN (0, 1)),
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  hold_step_id TEXT,
  changed_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, hold_step_id),
  UNIQUE (tenant_id, specialist_id, revision),
  -- The AI auditor is never put on hold (contract "Delegation", rule 7).
  CHECK (NOT (held = 1 AND specialist_id = 'independent_auditor'))
);

CREATE TRIGGER IF NOT EXISTS prevent_agent_specialist_control_update
BEFORE UPDATE ON agent_specialist_controls
BEGIN
  SELECT RAISE(ABORT, 'agent_specialist_controls_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_specialist_control_delete
BEFORE DELETE ON agent_specialist_controls
BEGIN
  SELECT RAISE(ABORT, 'agent_specialist_controls_append_only');
END;

CREATE TABLE IF NOT EXISTS agent_step_decisions (
  decision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  step_id TEXT NOT NULL UNIQUE REFERENCES agent_run_steps (step_id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'decline', 'do_it_myself')),
  step_version INTEGER NOT NULL,
  args_sha256 TEXT NOT NULL,
  decided_by_user_id TEXT NOT NULL,
  decided_role TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TRIGGER IF NOT EXISTS prevent_agent_step_decision_update
BEFORE UPDATE ON agent_step_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent_step_decisions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_step_decision_delete
BEFORE DELETE ON agent_step_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent_step_decisions_append_only');
END;

CREATE TABLE IF NOT EXISTS agent_exceptions (
  exception_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('step', 'host_alert')),
  run_id TEXT,
  step_id TEXT,
  host_id TEXT,
  alert TEXT,
  reason_code TEXT NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('immediate', 'today', 'brief')),
  reviewer_role TEXT NOT NULL,
  assigned_user_id TEXT,
  summary TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by_user_id TEXT,
  UNIQUE (tenant_id, dedupe_key),
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by_user_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_exceptions_open ON agent_exceptions (tenant_id, acknowledged_at, opened_at);

CREATE TRIGGER IF NOT EXISTS prevent_agent_exception_rewrite
BEFORE UPDATE OF exception_id, tenant_id, source, run_id, step_id, host_id, alert, reason_code,
  urgency, reviewer_role, assigned_user_id, summary, dedupe_key, opened_at ON agent_exceptions
BEGIN
  SELECT RAISE(ABORT, 'agent_exception_immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_exception_reopen
BEFORE UPDATE OF acknowledged_at, acknowledged_by_user_id ON agent_exceptions
WHEN OLD.acknowledged_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'agent_exception_acknowledged');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_exception_delete
BEFORE DELETE ON agent_exceptions
BEGIN
  SELECT RAISE(ABORT, 'agent_exceptions_append_only');
END;


-- Insert only on a failed comparison. Aborting inside the batch rolls back preceding writes too;
-- successful control/decision transactions never retain a guard row.
CREATE TABLE IF NOT EXISTS agent_control_guard (
  kind TEXT NOT NULL CHECK (kind IN ('authority', 'version', 'step'))
);

CREATE TRIGGER IF NOT EXISTS agent_control_guard_abort
BEFORE INSERT ON agent_control_guard
BEGIN
  SELECT RAISE(ABORT, 'agent_control_authority') WHERE NEW.kind = 'authority';
  SELECT RAISE(ABORT, 'agent_control_version') WHERE NEW.kind = 'version';
  SELECT RAISE(ABORT, 'agent_control_step') WHERE NEW.kind = 'step';
END;

CREATE TRIGGER IF NOT EXISTS agent_delegation_owner_guard
BEFORE INSERT ON agent_delegation_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_control_authority') WHERE NOT EXISTS (
    SELECT 1 FROM app_users WHERE tenant_id = NEW.tenant_id AND user_id = NEW.set_by_user_id
      AND active = 1 AND COALESCE(access_role, role) = 'owner'
  );
END;

CREATE TRIGGER IF NOT EXISTS agent_decision_scope_guard
BEFORE INSERT ON agent_step_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent_control_step') WHERE NOT EXISTS (
    SELECT 1 FROM agent_run_steps s
    JOIN app_users u ON u.tenant_id = s.tenant_id AND u.user_id = NEW.decided_by_user_id
    WHERE s.tenant_id = NEW.tenant_id
      AND u.active = 1 AND COALESCE(u.access_role, u.role) = NEW.decided_role
      AND (NEW.decided_role = 'owner' OR NEW.decided_role = s.needs_reviewer_role) AND s.step_id = NEW.step_id
      AND s.version = NEW.step_version AND s.args_sha256 = NEW.args_sha256
      AND s.outcome IS NULL AND s.autonomy <> 'H'
      AND json_extract(s.policy_json, '$.result') = 'needs_approval'
  );
END;


-- BEFORE INSERT sees every conflict before REPLACE can delete the retained row with D1's
-- recursive_triggers default OFF. Cover all primary/revision/idempotency/effect uniqueness keys.
CREATE TRIGGER IF NOT EXISTS agent_delegation_settings_no_insert_replace
BEFORE INSERT ON agent_delegation_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_delegation_settings_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_delegation_settings d WHERE d.setting_id = NEW.setting_id
      OR (d.tenant_id = NEW.tenant_id AND d.specialist_id = NEW.specialist_id
        AND d.action_id = NEW.action_id AND d.revision = NEW.revision)
      OR (d.tenant_id = NEW.tenant_id AND d.idempotency_key = NEW.idempotency_key)
  );
END;

CREATE TRIGGER IF NOT EXISTS agent_specialist_controls_no_insert_replace
BEFORE INSERT ON agent_specialist_controls
BEGIN
  SELECT RAISE(ABORT, 'agent_specialist_controls_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_specialist_controls c WHERE c.control_id = NEW.control_id
      OR (c.tenant_id = NEW.tenant_id AND c.idempotency_key = NEW.idempotency_key)
      OR (c.tenant_id = NEW.tenant_id AND c.hold_step_id = NEW.hold_step_id)
      OR (c.tenant_id = NEW.tenant_id AND c.specialist_id = NEW.specialist_id AND c.revision = NEW.revision)
  );
END;

CREATE TRIGGER IF NOT EXISTS agent_step_decisions_no_insert_replace
BEFORE INSERT ON agent_step_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent_step_decisions_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_step_decisions d WHERE d.decision_id = NEW.decision_id OR d.step_id = NEW.step_id
      OR (d.tenant_id = NEW.tenant_id AND d.idempotency_key = NEW.idempotency_key)
  );
END;

CREATE TRIGGER IF NOT EXISTS agent_exceptions_no_insert_replace
BEFORE INSERT ON agent_exceptions
BEGIN
  SELECT RAISE(ABORT, 'agent_exception_immutable') WHERE EXISTS (
    SELECT 1 FROM agent_exceptions e WHERE e.exception_id = NEW.exception_id
      OR (e.tenant_id = NEW.tenant_id AND e.dedupe_key = NEW.dedupe_key)
  );
END;
