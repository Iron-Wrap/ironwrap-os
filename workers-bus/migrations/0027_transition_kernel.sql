-- 0027_transition_kernel.sql - provider-neutral execution intent and outbox evidence.
--
-- An approval claim is the authority boundary. The first trigger below records
-- the governed transition and a never-attempted outbox item in the same D1
-- transaction as `pending -> executing`. The outbox holds canonical references
-- and bounded codes only: never raw request arguments, broker receipts, result
-- payloads, reconciliation narratives, or secrets.

CREATE TABLE IF NOT EXISTS governed_transitions (
  transition_id TEXT PRIMARY KEY CHECK (
    length(transition_id) BETWEEN 12 AND 160
    AND transition_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  subject_kind TEXT NOT NULL CHECK (subject_kind = 'approval_request'),
  subject_ref TEXT NOT NULL CHECK (
    length(subject_ref) BETWEEN 12 AND 80
    AND subject_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_kind TEXT NOT NULL CHECK (request_kind = 'lead_triage'),
  transition_kind TEXT NOT NULL CHECK (transition_kind = 'approval_execution'),
  state_from TEXT NOT NULL CHECK (state_from = 'pending'),
  state_to TEXT NOT NULL CHECK (state_to = 'executing'),
  subject_version INTEGER NOT NULL CHECK (subject_version >= 2),
  authority_ref TEXT NOT NULL CHECK (length(authority_ref) BETWEEN 1 AND 140),
  policy_ref TEXT NOT NULL CHECK (length(policy_ref) BETWEEN 3 AND 280),
  decision_idempotency_key TEXT NOT NULL CHECK (length(decision_idempotency_key) BETWEEN 8 AND 140),
  intent_digest TEXT NOT NULL CHECK (
    length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'
  ),
  args_digest TEXT NOT NULL CHECK (
    length(args_digest) = 64 AND args_digest NOT GLOB '*[^0-9a-f]*'
  ),
  preview_digest TEXT NOT NULL CHECK (
    length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^0-9a-f]*'
  ),
  correlation_ref TEXT NOT NULL CHECK (length(correlation_ref) BETWEEN 8 AND 128),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, subject_kind, subject_ref, decision_idempotency_key),
  FOREIGN KEY (subject_ref, tenant_id)
    REFERENCES approval_requests(approval_request_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_governed_transitions_tenant_created
  ON governed_transitions (tenant_id, created_at DESC, transition_id DESC);

CREATE TABLE IF NOT EXISTS governed_transition_outbox (
  outbox_id TEXT PRIMARY KEY CHECK (
    length(outbox_id) BETWEEN 12 AND 160
    AND outbox_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  transition_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  approval_request_id TEXT NOT NULL CHECK (
    length(approval_request_id) BETWEEN 12 AND 80
    AND approval_request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_kind TEXT NOT NULL CHECK (request_kind = 'lead_triage'),
  outbox_kind TEXT NOT NULL CHECK (outbox_kind = 'approval_execution_dispatch'),
  decision_idempotency_key TEXT NOT NULL CHECK (length(decision_idempotency_key) BETWEEN 8 AND 140),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'leased', 'succeeded', 'failed', 'audit_failed', 'uncertain', 'reconciled')
  ),
  due_at TEXT NOT NULL,
  lease_ref TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
  attempt_mode TEXT NOT NULL DEFAULT 'none' CHECK (attempt_mode IN ('none', 'leased', 'inferred_terminal')),
  attempted_at TEXT,
  result_ref TEXT,
  result_code TEXT CHECK (
    result_code IS NULL OR (
      length(result_code) BETWEEN 3 AND 120
      AND result_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  reconciled_at TEXT,
  reconciliation_outcome TEXT CHECK (
    reconciliation_outcome IS NULL OR reconciliation_outcome IN ('executed', 'not_executed', 'inconclusive')
  ),
  reconciliation_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, approval_request_id, decision_idempotency_key),
  CHECK (
    state != 'pending'
    OR (
      attempt_count = 0 AND attempt_mode = 'none' AND attempted_at IS NULL AND lease_ref IS NULL
      AND lease_expires_at IS NULL
      AND result_ref IS NULL AND result_code IS NULL AND reconciled_at IS NULL
      AND reconciliation_outcome IS NULL AND reconciliation_ref IS NULL
    )
  ),
  CHECK (
    state != 'leased'
    OR (
      attempt_count = 1 AND attempt_mode = 'leased' AND attempted_at IS NOT NULL
      AND lease_ref = decision_idempotency_key
      AND lease_expires_at IS NOT NULL AND lease_expires_at > attempted_at
      AND result_ref IS NULL AND result_code IS NULL AND reconciled_at IS NULL
      AND reconciliation_outcome IS NULL AND reconciliation_ref IS NULL
    )
  ),
  CHECK (
    state NOT IN ('succeeded', 'failed', 'audit_failed')
    OR (
      attempt_count = 1 AND attempt_mode IN ('leased', 'inferred_terminal') AND attempted_at IS NOT NULL
      AND lease_ref = decision_idempotency_key
      AND lease_expires_at IS NULL AND result_ref IS NOT NULL
      AND reconciled_at IS NULL AND reconciliation_outcome IS NULL AND reconciliation_ref IS NULL
    )
  ),
  CHECK (state != 'succeeded' OR result_code IS NULL),
  CHECK (state NOT IN ('failed', 'audit_failed') OR result_code IS NOT NULL),
  CHECK (
    state != 'uncertain'
    OR (
      lease_expires_at IS NULL AND result_ref IS NOT NULL AND result_code IS NOT NULL
      AND reconciled_at IS NULL AND reconciliation_outcome IS NULL AND reconciliation_ref IS NULL
      AND attempt_count = 1 AND attempt_mode IN ('leased', 'inferred_terminal')
      AND attempted_at IS NOT NULL AND lease_ref = decision_idempotency_key
    )
  ),
  CHECK (
    state != 'reconciled'
    OR (
      lease_expires_at IS NULL AND result_ref IS NOT NULL AND result_code IS NOT NULL
      AND reconciled_at IS NOT NULL AND reconciliation_outcome IS NOT NULL AND reconciliation_ref IS NOT NULL
      AND attempt_count = 1 AND attempt_mode IN ('leased', 'inferred_terminal')
      AND attempted_at IS NOT NULL AND lease_ref = decision_idempotency_key
    )
  ),
  FOREIGN KEY (transition_id) REFERENCES governed_transitions(transition_id) ON DELETE RESTRICT,
  FOREIGN KEY (approval_request_id, tenant_id)
    REFERENCES approval_requests(approval_request_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_governed_transition_outbox_pending
  ON governed_transition_outbox (tenant_id, due_at, outbox_id)
  WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS governed_transition_outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('intent_recorded', 'leased', 'succeeded', 'failed', 'audit_failed', 'uncertain', 'reconciled')
  ),
  outbox_state TEXT NOT NULL CHECK (
    outbox_state IN ('pending', 'leased', 'succeeded', 'failed', 'audit_failed', 'uncertain', 'reconciled')
  ),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1),
  attempt_mode TEXT NOT NULL CHECK (attempt_mode IN ('none', 'leased', 'inferred_terminal')),
  lease_ref TEXT,
  result_ref TEXT,
  reconciliation_ref TEXT,
  result_code TEXT CHECK (
    result_code IS NULL OR (
      length(result_code) BETWEEN 3 AND 120
      AND result_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  created_at TEXT NOT NULL,
  UNIQUE (outbox_id, event_type),
  FOREIGN KEY (outbox_id) REFERENCES governed_transition_outbox(outbox_id) ON DELETE RESTRICT,
  FOREIGN KEY (transition_id) REFERENCES governed_transitions(transition_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_governed_transition_outbox_events_tenant_created
  ON governed_transition_outbox_events (tenant_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS prevent_governed_transition_update
BEFORE UPDATE ON governed_transitions
BEGIN
  SELECT RAISE(ABORT, 'governed_transitions_immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_governed_transition_delete
BEFORE DELETE ON governed_transitions
BEGIN
  SELECT RAISE(ABORT, 'governed_transitions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS enforce_governed_transition_outbox_update
BEFORE UPDATE ON governed_transition_outbox
BEGIN
  SELECT RAISE(ABORT, 'governed_transition_outbox_binding_immutable')
    WHERE OLD.outbox_id IS NOT NEW.outbox_id
      OR OLD.transition_id IS NOT NEW.transition_id
      OR OLD.tenant_id IS NOT NEW.tenant_id
      OR OLD.approval_request_id IS NOT NEW.approval_request_id
      OR OLD.request_kind IS NOT NEW.request_kind
      OR OLD.outbox_kind IS NOT NEW.outbox_kind
      OR OLD.decision_idempotency_key IS NOT NEW.decision_idempotency_key
      OR OLD.due_at IS NOT NEW.due_at
      OR OLD.created_at IS NOT NEW.created_at;
  SELECT RAISE(ABORT, 'governed_transition_outbox_state_change_required')
    WHERE OLD.state = NEW.state;
  SELECT RAISE(ABORT, 'governed_transition_outbox_invalid_pending_transition')
    WHERE OLD.state = 'pending' AND NEW.state NOT IN ('leased', 'succeeded', 'failed', 'audit_failed', 'uncertain');
  SELECT RAISE(ABORT, 'governed_transition_outbox_invalid_leased_transition')
    WHERE OLD.state = 'leased' AND NEW.state NOT IN ('succeeded', 'failed', 'audit_failed', 'uncertain');
  SELECT RAISE(ABORT, 'governed_transition_outbox_invalid_uncertain_transition')
    WHERE OLD.state = 'uncertain' AND NEW.state != 'reconciled';
  SELECT RAISE(ABORT, 'governed_transition_outbox_terminal')
    WHERE OLD.state IN ('succeeded', 'failed', 'audit_failed', 'reconciled');
END;

CREATE TRIGGER IF NOT EXISTS prevent_governed_transition_outbox_delete
BEFORE DELETE ON governed_transition_outbox
BEGIN
  SELECT RAISE(ABORT, 'governed_transition_outbox_append_only');
END;

CREATE TRIGGER IF NOT EXISTS append_governed_transition_outbox_intent_event
AFTER INSERT ON governed_transition_outbox
BEGIN
  INSERT INTO governed_transition_outbox_events (
    outbox_id, transition_id, tenant_id, event_type, outbox_state, attempt_count, attempt_mode,
    lease_ref, result_ref, reconciliation_ref, result_code, created_at
  ) VALUES (
    NEW.outbox_id, NEW.transition_id, NEW.tenant_id, 'intent_recorded', NEW.state, NEW.attempt_count,
    NEW.attempt_mode, NULL, NULL, NULL, NULL, NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS append_governed_transition_outbox_state_event
AFTER UPDATE OF state ON governed_transition_outbox
BEGIN
  INSERT INTO governed_transition_outbox_events (
    outbox_id, transition_id, tenant_id, event_type, outbox_state, attempt_count, attempt_mode,
    lease_ref, result_ref, reconciliation_ref, result_code, created_at
  ) VALUES (
    NEW.outbox_id, NEW.transition_id, NEW.tenant_id, NEW.state, NEW.state, NEW.attempt_count,
    NEW.attempt_mode, NEW.lease_ref, NEW.result_ref, NEW.reconciliation_ref, NEW.result_code, NEW.updated_at
  );
END;

-- A pending intent has no recorded broker attempt. Refresh the approval lease
-- in the same transaction as its first dispatch claim so the five-minute
-- recovery sweep can safely resume a crashed request without ever reclaiming
-- a leased or uncertain attempt.
CREATE TRIGGER IF NOT EXISTS renew_approval_execution_lease_from_governed_outbox_claim
AFTER UPDATE OF state ON governed_transition_outbox
WHEN OLD.state = 'pending' AND NEW.state = 'leased'
  AND NEW.attempt_count = 1 AND NEW.attempt_mode = 'leased'
BEGIN
  UPDATE approval_requests
  SET execution_lease_expires_at = NEW.lease_expires_at,
      updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id
    AND approval_request_id = NEW.approval_request_id
    AND state = 'executing'
    AND decision_idempotency_key = NEW.decision_idempotency_key;
END;

CREATE TRIGGER IF NOT EXISTS prevent_governed_transition_outbox_event_update
BEFORE UPDATE ON governed_transition_outbox_events
BEGIN
  SELECT RAISE(ABORT, 'governed_transition_outbox_events_immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_governed_transition_outbox_event_delete
BEFORE DELETE ON governed_transition_outbox_events
BEGIN
  SELECT RAISE(ABORT, 'governed_transition_outbox_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS enqueue_governed_transition_from_approval_claim
AFTER UPDATE OF state ON approval_requests
WHEN OLD.state = 'pending' AND NEW.state = 'executing' AND NEW.request_kind = 'lead_triage'
BEGIN
  INSERT INTO governed_transitions (
    transition_id, tenant_id, subject_kind, subject_ref, request_kind, transition_kind,
    state_from, state_to, subject_version, authority_ref, policy_ref, decision_idempotency_key,
    intent_digest, args_digest, preview_digest, correlation_ref, created_at
  ) VALUES (
    'approval-exec:' || NEW.approval_request_id,
    NEW.tenant_id,
    'approval_request',
    NEW.approval_request_id,
    NEW.request_kind,
    'approval_execution',
    OLD.state,
    NEW.state,
    NEW.version,
    NEW.approved_by_user_id,
    NEW.write_tool || ':' || NEW.dry_run_tool,
    NEW.decision_idempotency_key,
    NEW.intent_fingerprint,
    NEW.args_digest,
    NEW.preview_digest,
    NEW.run_id,
    NEW.updated_at
  );

  INSERT INTO governed_transition_outbox (
    outbox_id, transition_id, tenant_id, approval_request_id, request_kind, outbox_kind,
    decision_idempotency_key, state, due_at, lease_ref, lease_expires_at, attempt_count,
    attempt_mode, attempted_at, result_ref, result_code, reconciled_at, reconciliation_outcome,
    reconciliation_ref, created_at, updated_at
  ) VALUES (
    'approval-exec:' || NEW.approval_request_id,
    'approval-exec:' || NEW.approval_request_id,
    NEW.tenant_id,
    NEW.approval_request_id,
    NEW.request_kind,
    'approval_execution_dispatch',
    NEW.decision_idempotency_key,
    'pending',
    NEW.approved_at,
    NULL,
    NULL,
    0,
    'none',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NEW.updated_at,
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS project_governed_transition_outbox_terminal
AFTER UPDATE OF state ON approval_requests
WHEN OLD.state = 'executing' AND NEW.state IN ('executed', 'failed', 'audit_failed', 'execution_uncertain')
BEGIN
  UPDATE governed_transition_outbox
  SET
    state = 'succeeded',
    lease_ref = NEW.decision_idempotency_key,
    lease_expires_at = NULL,
    attempt_count = 1,
    attempt_mode = COALESCE(NULLIF(attempt_mode, 'none'), 'inferred_terminal'),
    attempted_at = COALESCE(attempted_at, NEW.approved_at, NEW.updated_at),
    result_ref = COALESCE(NEW.hermes_run_id, 'approval:' || NEW.approval_request_id),
    result_code = NULL,
    updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id
    AND approval_request_id = NEW.approval_request_id
    AND decision_idempotency_key = NEW.decision_idempotency_key
    AND NEW.state = 'executed';

  UPDATE governed_transition_outbox
  SET
    state = 'failed',
    lease_ref = NEW.decision_idempotency_key,
    lease_expires_at = NULL,
    attempt_count = 1,
    attempt_mode = COALESCE(NULLIF(attempt_mode, 'none'), 'inferred_terminal'),
    attempted_at = COALESCE(attempted_at, NEW.approved_at, NEW.updated_at),
    result_ref = COALESCE(NEW.hermes_run_id, 'approval:' || NEW.approval_request_id),
    result_code = NEW.error_code,
    updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id
    AND approval_request_id = NEW.approval_request_id
    AND decision_idempotency_key = NEW.decision_idempotency_key
    AND NEW.state = 'failed';

  UPDATE governed_transition_outbox
  SET
    state = 'audit_failed',
    lease_ref = NEW.decision_idempotency_key,
    lease_expires_at = NULL,
    attempt_count = 1,
    attempt_mode = COALESCE(NULLIF(attempt_mode, 'none'), 'inferred_terminal'),
    attempted_at = COALESCE(attempted_at, NEW.approved_at, NEW.updated_at),
    result_ref = COALESCE(NEW.hermes_run_id, 'approval:' || NEW.approval_request_id),
    result_code = NEW.error_code,
    updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id
    AND approval_request_id = NEW.approval_request_id
    AND decision_idempotency_key = NEW.decision_idempotency_key
    AND NEW.state = 'audit_failed';

  UPDATE governed_transition_outbox
  SET
    state = 'uncertain',
    lease_ref = NEW.decision_idempotency_key,
    lease_expires_at = NULL,
    attempt_count = 1,
    attempt_mode = COALESCE(NULLIF(attempt_mode, 'none'), 'inferred_terminal'),
    attempted_at = COALESCE(attempted_at, NEW.approved_at, NEW.updated_at),
    result_ref = COALESCE(NEW.hermes_run_id, 'approval:' || NEW.approval_request_id),
    result_code = NEW.error_code,
    updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id
    AND approval_request_id = NEW.approval_request_id
    AND decision_idempotency_key = NEW.decision_idempotency_key
    AND NEW.state = 'execution_uncertain';
END;

CREATE TRIGGER IF NOT EXISTS project_governed_transition_outbox_reconciliation
AFTER UPDATE OF reconciled_at ON approval_requests
WHEN NEW.reconciled_at IS NOT NULL AND OLD.reconciled_at IS NULL
BEGIN
  UPDATE governed_transition_outbox
  SET
    state = 'reconciled',
    reconciled_at = NEW.reconciled_at,
    reconciliation_outcome = NEW.reconciliation_outcome,
    reconciliation_ref = 'approval-reconciliation:' || NEW.approval_request_id,
    updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id
    AND approval_request_id = NEW.approval_request_id
    AND decision_idempotency_key = NEW.decision_idempotency_key;
END;
