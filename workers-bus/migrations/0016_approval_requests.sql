-- 0016_approval_requests.sql - durable, tenant-scoped human approval ledger.
--
-- `approval_requests` is the mutable current projection. The append-only
-- `approval_request_events` table is the audit authority. Browser code never
-- receives a dry-run receipt, approval receipt, raw write arguments, or a
-- generic mutation capability.

CREATE TABLE IF NOT EXISTS approval_requests (
  approval_request_id TEXT PRIMARY KEY CHECK (
    length(approval_request_id) BETWEEN 12 AND 80
    AND approval_request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  request_kind TEXT NOT NULL CHECK (request_kind = 'lead_triage'),
  state TEXT NOT NULL CHECK (
    state IN (
      'pending', 'executing', 'executed', 'denied', 'expired', 'failed',
      'audit_failed', 'execution_uncertain'
    )
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  prepare_idempotency_key TEXT NOT NULL CHECK (length(prepare_idempotency_key) BETWEEN 8 AND 140),
  intent_fingerprint TEXT NOT NULL CHECK (
    length(intent_fingerprint) = 64 AND intent_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),

  -- Static evidence from the broker-produced MCP dry run. These bindings may
  -- never be rewritten after insertion.
  write_tool TEXT NOT NULL CHECK (write_tool = 'request_mark_lead_triaged'),
  dry_run_tool TEXT NOT NULL CHECK (dry_run_tool = 'dry_run_mark_lead_triaged'),
  agent_role TEXT NOT NULL CHECK (length(agent_role) BETWEEN 3 AND 140),
  actor_user TEXT NOT NULL CHECK (length(actor_user) BETWEEN 3 AND 140),
  site_id TEXT NOT NULL CHECK (length(site_id) BETWEEN 1 AND 280),
  target_doctype TEXT NOT NULL CHECK (target_doctype = 'Lead Envelope'),
  target_name TEXT NOT NULL CHECK (length(target_name) BETWEEN 1 AND 140),
  lead_envelope_id TEXT NOT NULL CHECK (length(lead_envelope_id) BETWEEN 1 AND 140),
  request_text TEXT NOT NULL CHECK (length(request_text) BETWEEN 1 AND 4000),
  write_args_json TEXT NOT NULL CHECK (length(write_args_json) BETWEEN 2 AND 16000),
  preview_json TEXT NOT NULL CHECK (length(preview_json) BETWEEN 2 AND 16000),
  args_digest TEXT NOT NULL CHECK (length(args_digest) = 64 AND args_digest NOT GLOB '*[^0-9a-f]*'),
  preview_digest TEXT NOT NULL CHECK (length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^0-9a-f]*'),
  dry_run_receipt TEXT NOT NULL CHECK (length(dry_run_receipt) BETWEEN 32 AND 8192),
  expires_at TEXT NOT NULL,

  requested_by_user_id TEXT NOT NULL,
  requested_by_frappe_user TEXT,
  approved_by_user_id TEXT,
  approved_by_frappe_user TEXT,
  approved_at TEXT,
  decision_idempotency_key TEXT CHECK (
    decision_idempotency_key IS NULL OR length(decision_idempotency_key) BETWEEN 8 AND 140
  ),
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL OR length(rejection_reason) BETWEEN 3 AND 1000
  ),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 8 AND 128),
  execution_lease_expires_at TEXT,
  hermes_run_id TEXT,
  result_json TEXT CHECK (result_json IS NULL OR length(result_json) BETWEEN 2 AND 16000),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 3 AND 120
      AND error_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),

  -- A reconciliation never re-opens or retries an uncertain execution. It
  -- records who compared the immutable run id with the business audit.
  reconciled_at TEXT,
  reconciled_by_user_id TEXT,
  reconciled_by_frappe_user TEXT,
  reconciliation_outcome TEXT CHECK (
    reconciliation_outcome IS NULL OR reconciliation_outcome IN ('executed', 'not_executed', 'inconclusive')
  ),
  reconciliation_evidence TEXT CHECK (
    reconciliation_evidence IS NULL OR length(reconciliation_evidence) BETWEEN 3 AND 1000
  ),

  -- These fields are copied into the immutable event trigger on every allowed
  -- state transition or reconciliation. They are not browser-facing.
  transition_actor_kind TEXT NOT NULL CHECK (
    transition_actor_kind IN ('app_user', 'approval_broker', 'system')
  ),
  transition_actor_id TEXT,
  transition_actor_frappe_user TEXT,
  transition_detail_code TEXT CHECK (
    transition_detail_code IS NULL OR (
      length(transition_detail_code) BETWEEN 3 AND 120
      AND transition_detail_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,

  UNIQUE (approval_request_id, tenant_id),
  UNIQUE (tenant_id, prepare_idempotency_key),
  CHECK (target_name = lead_envelope_id),
  CHECK (expires_at > created_at),
  CHECK (
    state != 'pending'
    OR (
      approved_by_user_id IS NULL AND approved_by_frappe_user IS NULL AND approved_at IS NULL
      AND decision_idempotency_key IS NULL AND rejection_reason IS NULL
      AND execution_lease_expires_at IS NULL AND completed_at IS NULL
      AND hermes_run_id IS NULL AND result_json IS NULL AND error_code IS NULL
    )
  ),
  CHECK (
    state NOT IN ('executing', 'executed', 'failed', 'audit_failed', 'execution_uncertain')
    OR (
      approved_by_user_id IS NOT NULL AND approved_by_frappe_user IS NOT NULL
      AND approved_at IS NOT NULL AND decision_idempotency_key IS NOT NULL
    )
  ),
  CHECK (
    state != 'executing'
    OR (execution_lease_expires_at IS NOT NULL AND completed_at IS NULL)
  ),
  CHECK (
    state NOT IN ('executed', 'failed', 'audit_failed', 'execution_uncertain', 'denied', 'expired')
    OR (execution_lease_expires_at IS NULL AND completed_at IS NOT NULL)
  ),
  CHECK (
    state != 'denied'
    OR (
      approved_by_user_id IS NOT NULL AND approved_by_frappe_user IS NOT NULL
      AND approved_at IS NOT NULL AND decision_idempotency_key IS NOT NULL
      AND rejection_reason IS NOT NULL
    )
  ),
  CHECK (
    state != 'executed'
    OR (hermes_run_id IS NOT NULL AND result_json IS NOT NULL AND error_code IS NULL)
  ),
  CHECK (
    state NOT IN ('failed', 'audit_failed', 'execution_uncertain')
    OR error_code IS NOT NULL
  ),
  CHECK (
    reconciled_at IS NULL
    OR (
      state = 'execution_uncertain' AND reconciled_by_user_id IS NOT NULL
      AND reconciled_by_frappe_user IS NOT NULL AND reconciliation_outcome IS NOT NULL
      AND reconciliation_evidence IS NOT NULL
    )
  ),
  FOREIGN KEY (requested_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (reconciled_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_tenant_state_updated
  ON approval_requests (tenant_id, state, updated_at DESC, approval_request_id DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_state_lease
  ON approval_requests (state, execution_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending_expiry
  ON approval_requests (state, expires_at);

CREATE TABLE IF NOT EXISTS approval_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_request_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  request_version INTEGER NOT NULL CHECK (request_version >= 1),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'prepared', 'execution_claimed', 'executed', 'denied', 'expired',
      'failed', 'audit_failed', 'execution_uncertain', 'reconciled'
    )
  ),
  state_from TEXT,
  state_to TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('app_user', 'approval_broker', 'system')),
  actor_id TEXT,
  actor_frappe_user TEXT,
  detail_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (approval_request_id, request_version),
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(approval_request_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_approval_request_events_tenant_created
  ON approval_request_events (tenant_id, created_at DESC, id DESC);

-- Static decision evidence can never be changed. A later correction must be
-- a new approval request, never an in-place rewrite of what a human saw.
CREATE TRIGGER IF NOT EXISTS prevent_approval_request_binding_rewrite
BEFORE UPDATE ON approval_requests
WHEN
  OLD.tenant_id IS NOT NEW.tenant_id
  OR OLD.request_kind IS NOT NEW.request_kind
  OR OLD.prepare_idempotency_key IS NOT NEW.prepare_idempotency_key
  OR OLD.intent_fingerprint IS NOT NEW.intent_fingerprint
  OR OLD.write_tool IS NOT NEW.write_tool
  OR OLD.dry_run_tool IS NOT NEW.dry_run_tool
  OR OLD.agent_role IS NOT NEW.agent_role
  OR OLD.actor_user IS NOT NEW.actor_user
  OR OLD.site_id IS NOT NEW.site_id
  OR OLD.target_doctype IS NOT NEW.target_doctype
  OR OLD.target_name IS NOT NEW.target_name
  OR OLD.lead_envelope_id IS NOT NEW.lead_envelope_id
  OR OLD.request_text IS NOT NEW.request_text
  OR OLD.write_args_json IS NOT NEW.write_args_json
  OR OLD.preview_json IS NOT NEW.preview_json
  OR OLD.args_digest IS NOT NEW.args_digest
  OR OLD.preview_digest IS NOT NEW.preview_digest
  OR OLD.dry_run_receipt IS NOT NEW.dry_run_receipt
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.requested_by_user_id IS NOT NEW.requested_by_user_id
  OR OLD.requested_by_frappe_user IS NOT NEW.requested_by_frappe_user
  OR OLD.run_id IS NOT NEW.run_id
  OR OLD.created_at IS NOT NEW.created_at
  OR (
    OLD.state = NEW.state
    AND NOT (OLD.reconciled_at IS NULL AND NEW.reconciled_at IS NOT NULL)
    AND NEW.version IS NOT OLD.version
  )
  OR (
    OLD.state = NEW.state
    AND NOT (OLD.reconciled_at IS NULL AND NEW.reconciled_at IS NOT NULL)
    AND (
      OLD.transition_actor_kind IS NOT NEW.transition_actor_kind
      OR OLD.transition_actor_id IS NOT NEW.transition_actor_id
      OR OLD.transition_actor_frappe_user IS NOT NEW.transition_actor_frappe_user
      OR OLD.transition_detail_code IS NOT NEW.transition_detail_code
    )
  )
  OR (
    OLD.reconciled_at IS NOT NULL AND (
      OLD.reconciled_at IS NOT NEW.reconciled_at
      OR OLD.reconciled_by_user_id IS NOT NEW.reconciled_by_user_id
      OR OLD.reconciled_by_frappe_user IS NOT NEW.reconciled_by_frappe_user
      OR OLD.reconciliation_outcome IS NOT NEW.reconciliation_outcome
      OR OLD.reconciliation_evidence IS NOT NEW.reconciliation_evidence
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'approval_request_binding_immutable');
END;

CREATE TRIGGER IF NOT EXISTS enforce_approval_request_transition
BEFORE UPDATE OF state ON approval_requests
BEGIN
  SELECT CASE WHEN NEW.version != OLD.version + 1
    THEN RAISE(ABORT, 'approval_request_version_transition_required') END;
  SELECT CASE WHEN OLD.state = 'pending' AND NEW.state NOT IN ('executing', 'denied', 'expired')
    THEN RAISE(ABORT, 'approval_request_invalid_pending_transition') END;
  SELECT CASE WHEN OLD.state = 'executing' AND NEW.state NOT IN ('executed', 'failed', 'audit_failed', 'execution_uncertain')
    THEN RAISE(ABORT, 'approval_request_invalid_executing_transition') END;
  SELECT CASE WHEN OLD.state NOT IN ('pending', 'executing')
    THEN RAISE(ABORT, 'approval_request_terminal_transition') END;
  SELECT CASE WHEN NEW.transition_actor_kind IS NULL
    THEN RAISE(ABORT, 'approval_request_transition_actor_required') END;
END;

CREATE TRIGGER IF NOT EXISTS enforce_approval_request_reconciliation
BEFORE UPDATE OF reconciled_at ON approval_requests
WHEN NEW.reconciled_at IS NOT NULL
BEGIN
  SELECT CASE WHEN OLD.state != 'execution_uncertain' OR NEW.state != 'execution_uncertain'
    THEN RAISE(ABORT, 'approval_request_reconciliation_requires_uncertain') END;
  SELECT CASE WHEN OLD.reconciled_at IS NOT NULL
    THEN RAISE(ABORT, 'approval_request_reconciliation_immutable') END;
  SELECT CASE WHEN NEW.version != OLD.version + 1
    THEN RAISE(ABORT, 'approval_request_reconciliation_version_required') END;
  SELECT CASE WHEN NEW.transition_actor_kind != 'app_user'
    THEN RAISE(ABORT, 'approval_request_reconciliation_actor_required') END;
END;

CREATE TRIGGER IF NOT EXISTS append_approval_request_created_event
AFTER INSERT ON approval_requests
BEGIN
  INSERT INTO approval_request_events (
    approval_request_id, tenant_id, request_version, event_type, state_from, state_to,
    actor_kind, actor_id, actor_frappe_user, detail_code, created_at
  ) VALUES (
    NEW.approval_request_id, NEW.tenant_id, NEW.version, 'prepared', NULL, NEW.state,
    'app_user', NEW.requested_by_user_id, NEW.requested_by_frappe_user, 'approval_prepared', NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS append_approval_request_transition_event
AFTER UPDATE OF state ON approval_requests
BEGIN
  INSERT INTO approval_request_events (
    approval_request_id, tenant_id, request_version, event_type, state_from, state_to,
    actor_kind, actor_id, actor_frappe_user, detail_code, created_at
  ) VALUES (
    NEW.approval_request_id,
    NEW.tenant_id,
    NEW.version,
    CASE
      WHEN OLD.state = 'pending' AND NEW.state = 'executing' THEN 'execution_claimed'
      WHEN NEW.state = 'executed' THEN 'executed'
      WHEN NEW.state = 'denied' THEN 'denied'
      WHEN NEW.state = 'expired' THEN 'expired'
      WHEN NEW.state = 'failed' THEN 'failed'
      WHEN NEW.state = 'audit_failed' THEN 'audit_failed'
      WHEN NEW.state = 'execution_uncertain' THEN 'execution_uncertain'
    END,
    OLD.state,
    NEW.state,
    NEW.transition_actor_kind,
    NEW.transition_actor_id,
    NEW.transition_actor_frappe_user,
    NEW.transition_detail_code,
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS append_approval_request_reconciliation_event
AFTER UPDATE OF reconciled_at ON approval_requests
WHEN NEW.reconciled_at IS NOT NULL AND OLD.reconciled_at IS NULL
BEGIN
  INSERT INTO approval_request_events (
    approval_request_id, tenant_id, request_version, event_type, state_from, state_to,
    actor_kind, actor_id, actor_frappe_user, detail_code, created_at
  ) VALUES (
    NEW.approval_request_id, NEW.tenant_id, NEW.version, 'reconciled', NEW.state, NEW.state,
    NEW.transition_actor_kind, NEW.transition_actor_id, NEW.transition_actor_frappe_user,
    NEW.transition_detail_code, NEW.reconciled_at
  );
END;

CREATE TRIGGER IF NOT EXISTS prevent_approval_request_event_update
BEFORE UPDATE ON approval_request_events
BEGIN
  SELECT RAISE(ABORT, 'approval_request_events_immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_approval_request_event_delete
BEFORE DELETE ON approval_request_events
BEGIN
  SELECT RAISE(ABORT, 'approval_request_events_immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_approval_request_delete
BEFORE DELETE ON approval_requests
BEGIN
  SELECT RAISE(ABORT, 'approval_requests_append_only');
END;
