-- AI team coordination (Track A, AI-TEAM-CONTRACT.md "Coordination run" and "Receipts").
--
-- One append-only coordination aggregate per run. A run records its trigger, goal, context
-- snapshot, tool manifest and the rules in force, then each proposed step with the deterministic
-- policy decision; the step row is the receipt. It references permits, approvals, effects and
-- exceptions by id and never copies their authority. Identity and proposal columns are immutable,
-- a closed run cannot change, and every change is mirrored into an append-only event ledger.

CREATE TABLE IF NOT EXISTS agent_signals (
  signal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'watch', 'owner_request', 'handoff')),
  specialist_id TEXT NOT NULL,
  watch_id TEXT,
  source TEXT NOT NULL,
  subject_aggregate TEXT,
  subject_id TEXT,
  content_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  parent_run_id TEXT,
  handoff_depth INTEGER NOT NULL DEFAULT 0 CHECK (handoff_depth >= 0),
  received_at TEXT NOT NULL,
  UNIQUE (tenant_id, dedupe_key),
  CHECK ((subject_aggregate IS NULL) = (subject_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_signals_tenant_seq ON agent_signals (tenant_id, signal_seq);

CREATE TRIGGER IF NOT EXISTS prevent_agent_signal_update
BEFORE UPDATE ON agent_signals
BEGIN
  SELECT RAISE(ABORT, 'agent_signals_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_signal_delete
BEFORE DELETE ON agent_signals
BEGIN
  SELECT RAISE(ABORT, 'agent_signals_append_only');
END;

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  signal_id TEXT NOT NULL REFERENCES agent_signals (signal_id),
  host_run_key TEXT NOT NULL,
  goal TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  context_snapshot_hash TEXT NOT NULL,
  tool_manifest_json TEXT NOT NULL,
  tool_manifest_hash TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  parent_run_id TEXT,
  correlation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  result TEXT CHECK (result IN ('completed', 'abstained', 'escalated', 'ceiling_reached', 'cancelled')),
  close_json TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  attempt_started_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (tenant_id, host_run_key),
  CHECK ((state = 'open') = (result IS NULL)),
  CHECK ((state = 'open') = (ended_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_state ON agent_runs (tenant_id, state, started_at);

CREATE TRIGGER IF NOT EXISTS prevent_agent_run_identity_update
BEFORE UPDATE OF run_id, tenant_id, specialist_id, signal_id, host_run_key, goal, trigger_json,
  context_json, context_snapshot_hash, tool_manifest_json, tool_manifest_hash, catalog_version,
  policy_version, parent_run_id, correlation_id, started_at ON agent_runs
BEGIN
  SELECT RAISE(ABORT, 'agent_run_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_closed_agent_run_update
BEFORE UPDATE ON agent_runs
WHEN OLD.state = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'agent_run_closed');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_run_delete
BEFORE DELETE ON agent_runs
BEGIN
  SELECT RAISE(ABORT, 'agent_runs_append_only');
END;

CREATE TABLE IF NOT EXISTS agent_run_steps (
  step_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs (run_id),
  step_seq INTEGER NOT NULL CHECK (step_seq >= 1),
  step_key TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  autonomy TEXT CHECK (autonomy IN ('A0', 'A1', 'A2', 'A3', 'H')),
  args_json TEXT NOT NULL,
  args_sha256 TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  permit_json TEXT NOT NULL,
  tool_json TEXT,
  readback_json TEXT,
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'unknown', 'abstained')),
  reason_code TEXT,
  needs_reviewer_role TEXT,
  needs_person_id TEXT,
  needs_ask TEXT,
  undo_json TEXT NOT NULL,
  do_it_myself_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (run_id, step_key),
  UNIQUE (run_id, step_seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_steps_tenant_open ON agent_run_steps (tenant_id, outcome, created_at);

CREATE TRIGGER IF NOT EXISTS prevent_agent_step_proposal_update
BEFORE UPDATE OF step_id, tenant_id, run_id, step_seq, step_key, specialist_id, action_id, autonomy,
  args_json, args_sha256, sources_json, created_at ON agent_run_steps
BEGIN
  SELECT RAISE(ABORT, 'agent_step_proposal_immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_step_delete
BEFORE DELETE ON agent_run_steps
BEGIN
  SELECT RAISE(ABORT, 'agent_run_steps_append_only');
END;

-- No step joins a closed run.
CREATE TRIGGER IF NOT EXISTS prevent_agent_step_on_closed_run
BEFORE INSERT ON agent_run_steps
WHEN (SELECT state FROM agent_runs WHERE run_id = NEW.run_id) = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'agent_run_closed');
END;

-- A decided step is final; only an open step, or an `unknown` one through reconciliation, changes.
CREATE TRIGGER IF NOT EXISTS prevent_decided_agent_step_update
BEFORE UPDATE ON agent_run_steps
WHEN OLD.outcome IS NOT NULL AND OLD.outcome <> 'unknown'
BEGIN
  SELECT RAISE(ABORT, 'agent_step_decided');
END;

-- Every run and step change, in order. Rows come only from the triggers below.
CREATE TABLE IF NOT EXISTS agent_run_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'resumed', 'closed', 'step_recorded', 'step_updated')),
  state_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events (run_id, event_seq);

CREATE TRIGGER IF NOT EXISTS prevent_agent_run_event_update
BEFORE UPDATE ON agent_run_events
BEGIN
  SELECT RAISE(ABORT, 'agent_run_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_run_event_delete
BEFORE DELETE ON agent_run_events
BEGIN
  SELECT RAISE(ABORT, 'agent_run_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS append_agent_run_opened_event
AFTER INSERT ON agent_runs
BEGIN
  INSERT INTO agent_run_events (tenant_id, run_id, step_id, event_type, state_json, occurred_at)
  VALUES (NEW.tenant_id, NEW.run_id, NULL, 'opened',
    json_object('attempt', NEW.attempt, 'context_snapshot_hash', NEW.context_snapshot_hash,
      'tool_manifest_hash', NEW.tool_manifest_hash, 'catalog_version', NEW.catalog_version),
    NEW.started_at);
END;

CREATE TRIGGER IF NOT EXISTS append_agent_run_resumed_event
AFTER UPDATE OF attempt ON agent_runs
WHEN NEW.attempt > OLD.attempt
BEGIN
  INSERT INTO agent_run_events (tenant_id, run_id, step_id, event_type, state_json, occurred_at)
  VALUES (NEW.tenant_id, NEW.run_id, NULL, 'resumed', json_object('attempt', NEW.attempt), NEW.attempt_started_at);
END;

CREATE TRIGGER IF NOT EXISTS append_agent_run_closed_event
AFTER UPDATE OF state ON agent_runs
WHEN NEW.state = 'closed'
BEGIN
  INSERT INTO agent_run_events (tenant_id, run_id, step_id, event_type, state_json, occurred_at)
  VALUES (NEW.tenant_id, NEW.run_id, NULL, 'closed', json_object('result', NEW.result), NEW.ended_at);
END;

CREATE TRIGGER IF NOT EXISTS append_agent_step_recorded_event
AFTER INSERT ON agent_run_steps
BEGIN
  INSERT INTO agent_run_events (tenant_id, run_id, step_id, event_type, state_json, occurred_at)
  VALUES (NEW.tenant_id, NEW.run_id, NEW.step_id, 'step_recorded',
    json_object('version', NEW.version, 'action_id', NEW.action_id, 'outcome', NEW.outcome,
      'reason_code', NEW.reason_code, 'policy', json(NEW.policy_json), 'permit', json(NEW.permit_json)),
    NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS append_agent_step_updated_event
AFTER UPDATE ON agent_run_steps
BEGIN
  INSERT INTO agent_run_events (tenant_id, run_id, step_id, event_type, state_json, occurred_at)
  VALUES (NEW.tenant_id, NEW.run_id, NEW.step_id, 'step_updated',
    json_object('version', NEW.version, 'outcome', NEW.outcome, 'reason_code', NEW.reason_code,
      'policy', json(NEW.policy_json), 'permit', json(NEW.permit_json),
      'tool', json(COALESCE(NEW.tool_json, 'null')), 'readback', json(COALESCE(NEW.readback_json, 'null')),
      'needs_reviewer_role', NEW.needs_reviewer_role, 'needs_person_id', NEW.needs_person_id,
      'needs_ask', NEW.needs_ask, 'undo', json(NEW.undo_json), 'decided_at', NEW.decided_at),
    COALESCE(NEW.decided_at, NEW.created_at));
END;

-- The latest heartbeat per agent host: readiness, alerts and backlog for the owner's view.
CREATE TABLE IF NOT EXISTS agent_host_heartbeats (
  tenant_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_version TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
  alerts_json TEXT NOT NULL,
  providers_json TEXT NOT NULL,
  backlog_json TEXT NOT NULL,
  in_flight INTEGER NOT NULL CHECK (in_flight >= 0),
  received_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, host_id)
);


-- D1 defaults recursive_triggers to OFF: REPLACE can otherwise delete a protected row without
-- firing its DELETE guard. Refuse every primary/idempotency/sequence collision before replacement
-- resolution, following 0062. Normal replay skips the insert and verifies the retained proposal.
CREATE TRIGGER IF NOT EXISTS agent_signals_no_insert_replace
BEFORE INSERT ON agent_signals
BEGIN
  SELECT RAISE(ABORT, 'agent_signals_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_signals s WHERE s.signal_seq = NEW.signal_seq OR s.signal_id = NEW.signal_id
      OR (s.tenant_id = NEW.tenant_id AND s.dedupe_key = NEW.dedupe_key)
  );
END;

CREATE TRIGGER IF NOT EXISTS agent_runs_no_insert_replace
BEFORE INSERT ON agent_runs
BEGIN
  SELECT RAISE(ABORT, 'agent_run_identity_immutable') WHERE EXISTS (
    SELECT 1 FROM agent_runs r WHERE r.run_id = NEW.run_id
      OR (r.tenant_id = NEW.tenant_id AND r.host_run_key = NEW.host_run_key)
  );
END;

CREATE TRIGGER IF NOT EXISTS agent_run_steps_no_insert_replace
BEFORE INSERT ON agent_run_steps
BEGIN
  SELECT RAISE(ABORT, 'agent_step_proposal_immutable') WHERE EXISTS (
    SELECT 1 FROM agent_run_steps s WHERE s.step_id = NEW.step_id
      OR (s.run_id = NEW.run_id AND s.step_key = NEW.step_key)
      OR (s.run_id = NEW.run_id AND s.step_seq = NEW.step_seq)
  );
END;

CREATE TRIGGER IF NOT EXISTS agent_run_events_no_insert_replace
BEFORE INSERT ON agent_run_events
BEGIN
  SELECT RAISE(ABORT, 'agent_run_events_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_run_events e WHERE e.event_seq = NEW.event_seq
  );
END;
