-- 0040_postiz_control_plane.sql - governed Postiz execution outbox and readback ledger.
-- Postiz v2.23.0 executes approved work. IronWrap remains source of truth.

CREATE TABLE postiz_intents (
  intent_id TEXT PRIMARY KEY CHECK (
    length(intent_id) = 36
    AND intent_id GLOB '[0-9a-f]*'
    AND intent_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(intent_id, 9, 1) = '-'
    AND substr(intent_id, 14, 1) = '-'
    AND substr(intent_id, 15, 1) = '4'
    AND substr(intent_id, 19, 1) = '-'
    AND substr(intent_id, 20, 1) GLOB '[89ab]'
    AND substr(intent_id, 24, 1) = '-'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  remote_post_id TEXT NOT NULL UNIQUE CHECK (
    length(remote_post_id) = 36
    AND remote_post_id GLOB '[0-9a-f]*'
    AND remote_post_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(remote_post_id, 9, 1) = '-'
    AND substr(remote_post_id, 14, 1) = '-'
    AND substr(remote_post_id, 15, 1) = '4'
    AND substr(remote_post_id, 19, 1) = '-'
    AND substr(remote_post_id, 20, 1) GLOB '[89ab]'
    AND substr(remote_post_id, 24, 1) = '-'
  ),
  draft_idempotency_sha256 TEXT NOT NULL CHECK (
    length(draft_idempotency_sha256) = 64
    AND draft_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  intent_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(intent_fingerprint_sha256) = 64
    AND intent_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  drafted_by_agent_role TEXT NOT NULL CHECK (
    drafted_by_agent_role = 'specialized_marketing_agent'
  ),
  trigger_ref TEXT NOT NULL CHECK (length(trigger_ref) BETWEEN 1 AND 300),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 5000),
  provider TEXT NOT NULL CHECK (provider IN ('facebook', 'linkedin-page', 'gmb')),
  integration_id TEXT CHECK (
    integration_id IS NULL OR length(integration_id) BETWEEN 1 AND 200
  ),
  scheduled_at TEXT NOT NULL CHECK (length(scheduled_at) BETWEEN 24 AND 40),
  evidence_refs_json TEXT NOT NULL CHECK (length(evidence_refs_json) <= 8000),
  citations_json TEXT NOT NULL CHECK (length(citations_json) <= 16000),
  permission_scope TEXT NOT NULL CHECK (length(permission_scope) BETWEEN 1 AND 100),
  state TEXT NOT NULL CHECK (state IN (
    'connection_required', 'pending_review', 'rejected', 'submission_pending',
    'submitted', 'published', 'reconciliation_required', 'stop_submitted',
    'stop_reconciliation_required'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  submission_effect_id TEXT NOT NULL UNIQUE CHECK (
    length(submission_effect_id) = 36
    AND submission_effect_id GLOB '[0-9a-f]*'
    AND submission_effect_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(submission_effect_id, 9, 1) = '-'
    AND substr(submission_effect_id, 14, 1) = '-'
    AND substr(submission_effect_id, 15, 1) = '4'
    AND substr(submission_effect_id, 19, 1) = '-'
    AND substr(submission_effect_id, 20, 1) GLOB '[89ab]'
    AND substr(submission_effect_id, 24, 1) = '-'
  ),
  stop_effect_id TEXT NOT NULL UNIQUE CHECK (
    length(stop_effect_id) = 36
    AND stop_effect_id GLOB '[0-9a-f]*'
    AND stop_effect_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(stop_effect_id, 9, 1) = '-'
    AND substr(stop_effect_id, 14, 1) = '-'
    AND substr(stop_effect_id, 15, 1) = '4'
    AND substr(stop_effect_id, 19, 1) = '-'
    AND substr(stop_effect_id, 20, 1) GLOB '[89ab]'
    AND substr(stop_effect_id, 24, 1) = '-'
  ),
  approval_idempotency_sha256 TEXT UNIQUE CHECK (
    approval_idempotency_sha256 IS NULL OR (
      length(approval_idempotency_sha256) = 64
      AND approval_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  rejection_idempotency_sha256 TEXT UNIQUE CHECK (
    rejection_idempotency_sha256 IS NULL OR (
      length(rejection_idempotency_sha256) = 64
      AND rejection_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  stop_idempotency_sha256 TEXT UNIQUE CHECK (
    stop_idempotency_sha256 IS NULL OR (
      length(stop_idempotency_sha256) = 64
      AND stop_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  approved_by_user_id TEXT,
  approved_at TEXT,
  rejected_by_user_id TEXT,
  rejected_at TEXT,
  stop_requested_by_user_id TEXT,
  stop_requested_at TEXT,
  remote_state TEXT CHECK (
    remote_state IS NULL OR remote_state IN ('QUEUE', 'PUBLISHED', 'ERROR', 'DRAFT')
  ),
  release_url TEXT CHECK (release_url IS NULL OR length(release_url) <= 2048),
  last_reconciled_at TEXT,
  published_observed_at TEXT CHECK (
    published_observed_at IS NULL OR length(published_observed_at) BETWEEN 24 AND 40
  ),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 100),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 24 AND 40),
  UNIQUE (tenant_id, draft_idempotency_sha256),
  CHECK (state != 'published' OR published_observed_at IS NOT NULL),
  FOREIGN KEY (approved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (rejected_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (stop_requested_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_postiz_intents_actionable
  ON postiz_intents (tenant_id, state, updated_at);

-- This is the immutable proposal/decision/state history. It contains the
-- fingerprint of the bounded proposal, never the content or provider body.
CREATE TABLE postiz_intent_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  intent_version INTEGER NOT NULL CHECK (intent_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'proposed', 'connection_required', 'pending_review', 'approved', 'rejected',
    'submitted', 'published', 'reconciliation_required', 'stop_requested',
    'stop_reconciliation_required'
  )),
  state_from TEXT,
  state_to TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('specialized_marketing_agent', 'owner', 'system')),
  actor_user_id TEXT,
  intent_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(intent_fingerprint_sha256) = 64
    AND intent_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) <= 100),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 24 AND 40),
  UNIQUE (intent_id, intent_version),
  FOREIGN KEY (intent_id) REFERENCES postiz_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_postiz_intent_events_intent
  ON postiz_intent_events (intent_id, event_seq);

CREATE TRIGGER postiz_intent_events_append_only_update
BEFORE UPDATE ON postiz_intent_events BEGIN
  SELECT RAISE(ABORT, 'postiz_intent_events_append_only');
END;
CREATE TRIGGER postiz_intent_events_append_only_delete
BEFORE DELETE ON postiz_intent_events BEGIN
  SELECT RAISE(ABORT, 'postiz_intent_events_append_only');
END;

CREATE TRIGGER postiz_intents_proposed_event
AFTER INSERT ON postiz_intents BEGIN
  INSERT INTO postiz_intent_events
    (tenant_id, intent_id, intent_version, event_type, state_from, state_to,
     actor_kind, actor_user_id, intent_fingerprint_sha256, detail_code, occurred_at)
  VALUES
    (NEW.tenant_id, NEW.intent_id, NEW.version, 'proposed', NULL, NEW.state,
     'specialized_marketing_agent', NULL, NEW.intent_fingerprint_sha256,
     NEW.error_code, NEW.created_at);
END;

-- The outbox row is also the bounded submission receipt: it records only response
-- classification and status, never provider bodies, content, credentials, or OAuth URLs.
CREATE TABLE postiz_effect_outbox (
  effect_id TEXT PRIMARY KEY CHECK (length(effect_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('connect', 'submit', 'stop')),
  provider TEXT NOT NULL CHECK (provider IN ('facebook', 'linkedin-page', 'gmb')),
  requested_by_user_id TEXT,
  idempotency_key_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_sha256) = 64
    AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'attempting', 'submitted', 'failed', 'unknown')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
  attempted_at TEXT,
  response_class TEXT CHECK (
    response_class IS NULL OR response_class IN ('accepted', 'http_error', 'network_error', 'invalid_response')
  ),
  response_status INTEGER CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  ),
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) <= 100),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 24 AND 40),
  FOREIGN KEY (intent_id) REFERENCES postiz_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (requested_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (operation = 'connect' AND intent_id IS NULL AND requested_by_user_id IS NOT NULL)
    OR (operation IN ('submit', 'stop') AND intent_id IS NOT NULL)
  )
);

CREATE INDEX idx_postiz_effect_outbox_pending
  ON postiz_effect_outbox (state, created_at);

CREATE TRIGGER postiz_effect_outbox_single_attempt
BEFORE UPDATE OF attempt_count ON postiz_effect_outbox BEGIN
  SELECT RAISE(ABORT, 'postiz_effect_attempt_invalid')
  WHERE NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > 1;
END;

CREATE TABLE postiz_reconciliation_observations (
  observation_id TEXT PRIMARY KEY CHECK (length(observation_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'scheduled', 'connection_poll')),
  request_idempotency_sha256 TEXT UNIQUE CHECK (
    request_idempotency_sha256 IS NULL OR (
      length(request_idempotency_sha256) = 64
      AND request_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  provider_found INTEGER CHECK (provider_found IN (0, 1) OR provider_found IS NULL),
  remote_state TEXT CHECK (
    remote_state IS NULL OR remote_state IN ('QUEUE', 'PUBLISHED', 'ERROR', 'DRAFT')
  ),
  release_url TEXT CHECK (release_url IS NULL OR length(release_url) <= 2048),
  outcome_code TEXT NOT NULL CHECK (length(outcome_code) BETWEEN 1 AND 100),
  checked_at TEXT NOT NULL CHECK (length(checked_at) BETWEEN 24 AND 40),
  FOREIGN KEY (intent_id) REFERENCES postiz_intents(intent_id) ON DELETE RESTRICT
);

CREATE INDEX idx_postiz_reconciliation_intent
  ON postiz_reconciliation_observations (intent_id, checked_at);

CREATE TRIGGER postiz_reconciliation_observations_append_only_update
BEFORE UPDATE ON postiz_reconciliation_observations BEGIN
  SELECT RAISE(ABORT, 'postiz_reconciliation_observations_append_only');
END;
CREATE TRIGGER postiz_reconciliation_observations_append_only_delete
BEFORE DELETE ON postiz_reconciliation_observations BEGIN
  SELECT RAISE(ABORT, 'postiz_reconciliation_observations_append_only');
END;

CREATE TRIGGER postiz_intents_transition_guard
BEFORE UPDATE OF state ON postiz_intents BEGIN
  SELECT RAISE(ABORT, 'postiz_intent_transition_invalid')
  WHERE NOT (
    (OLD.state = 'connection_required' AND NEW.state IN ('connection_required', 'pending_review'))
    OR (OLD.state = 'pending_review' AND NEW.state IN ('connection_required', 'pending_review', 'rejected', 'submission_pending'))
    OR (OLD.state = 'submission_pending' AND NEW.state IN ('submitted', 'reconciliation_required'))
    OR (OLD.state = 'submitted' AND NEW.state IN ('submitted', 'published', 'reconciliation_required', 'stop_submitted'))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN ('submitted', 'published', 'reconciliation_required', 'stop_submitted'))
    OR (OLD.state = 'published' AND NEW.state IN ('published', 'reconciliation_required'))
    OR (OLD.state = 'stop_submitted' AND NEW.state = 'stop_reconciliation_required')
    OR (OLD.state = 'stop_reconciliation_required' AND NEW.state = 'stop_reconciliation_required')
    OR (OLD.state = 'rejected' AND NEW.state = 'rejected')
  );
END;

-- Once exact-id readback has observed publication, that fact is monotonic even
-- if the current provider projection later drifts or disappears.
CREATE TRIGGER postiz_intents_publication_evidence_guard
BEFORE UPDATE OF published_observed_at ON postiz_intents BEGIN
  SELECT RAISE(ABORT, 'postiz_publication_evidence_invalid')
  WHERE (OLD.published_observed_at IS NOT NULL
         AND NOT (NEW.published_observed_at IS OLD.published_observed_at))
     OR (OLD.published_observed_at IS NULL
         AND NEW.published_observed_at IS NOT NULL
         AND NEW.remote_state != 'PUBLISHED');
END;

CREATE TRIGGER postiz_intents_rejection_required
BEFORE UPDATE OF state ON postiz_intents
WHEN OLD.state = 'pending_review' AND NEW.state = 'rejected' BEGIN
  SELECT RAISE(ABORT, 'postiz_rejection_decision_required')
  WHERE NEW.rejected_by_user_id IS NULL
    OR NEW.rejected_at IS NULL
    OR NEW.rejection_idempotency_sha256 IS NULL;
END;

CREATE TRIGGER postiz_intents_version_guard
BEFORE UPDATE ON postiz_intents BEGIN
  SELECT RAISE(ABORT, 'postiz_intent_version_invalid')
  WHERE NEW.version != OLD.version + 1;
END;

CREATE TRIGGER postiz_intents_approved_event
AFTER UPDATE OF state ON postiz_intents
WHEN OLD.state = 'pending_review' AND NEW.state = 'submission_pending' BEGIN
  INSERT INTO postiz_intent_events
    (tenant_id, intent_id, intent_version, event_type, state_from, state_to,
     actor_kind, actor_user_id, intent_fingerprint_sha256, detail_code, occurred_at)
  VALUES
    (NEW.tenant_id, NEW.intent_id, NEW.version, 'approved', OLD.state, NEW.state,
     'owner', NEW.approved_by_user_id, NEW.intent_fingerprint_sha256,
     NEW.error_code, NEW.updated_at);
END;

CREATE TRIGGER postiz_intents_rejected_event
AFTER UPDATE OF state ON postiz_intents
WHEN OLD.state = 'pending_review' AND NEW.state = 'rejected' BEGIN
  INSERT INTO postiz_intent_events
    (tenant_id, intent_id, intent_version, event_type, state_from, state_to,
     actor_kind, actor_user_id, intent_fingerprint_sha256, detail_code, occurred_at)
  VALUES
    (NEW.tenant_id, NEW.intent_id, NEW.version, 'rejected', OLD.state, NEW.state,
     'owner', NEW.rejected_by_user_id, NEW.intent_fingerprint_sha256,
     NEW.error_code, NEW.updated_at);
END;

CREATE TRIGGER postiz_intents_stop_requested_event
AFTER UPDATE OF state ON postiz_intents
WHEN OLD.state IN ('submitted', 'reconciliation_required') AND NEW.state = 'stop_submitted' BEGIN
  INSERT INTO postiz_intent_events
    (tenant_id, intent_id, intent_version, event_type, state_from, state_to,
     actor_kind, actor_user_id, intent_fingerprint_sha256, detail_code, occurred_at)
  VALUES
    (NEW.tenant_id, NEW.intent_id, NEW.version, 'stop_requested', OLD.state, NEW.state,
     'owner', NEW.stop_requested_by_user_id, NEW.intent_fingerprint_sha256,
     NEW.error_code, NEW.updated_at);
END;

CREATE TRIGGER postiz_intents_system_event
AFTER UPDATE OF state ON postiz_intents
WHEN NOT (OLD.state = 'pending_review' AND NEW.state IN ('submission_pending', 'rejected'))
  AND NOT (OLD.state IN ('submitted', 'reconciliation_required') AND NEW.state = 'stop_submitted') BEGIN
  INSERT INTO postiz_intent_events
    (tenant_id, intent_id, intent_version, event_type, state_from, state_to,
     actor_kind, actor_user_id, intent_fingerprint_sha256, detail_code, occurred_at)
  VALUES
    (NEW.tenant_id, NEW.intent_id, NEW.version,
     NEW.state, OLD.state, NEW.state, 'system', NULL,
     NEW.intent_fingerprint_sha256, NEW.error_code, NEW.updated_at);
END;

CREATE TRIGGER postiz_intents_submission_outbox
AFTER UPDATE OF state ON postiz_intents
WHEN OLD.state = 'pending_review' AND NEW.state = 'submission_pending' BEGIN
  SELECT RAISE(ABORT, 'postiz_submission_approval_required')
  WHERE NEW.integration_id IS NULL
    OR NEW.approved_by_user_id IS NULL
    OR NEW.approved_at IS NULL
    OR NEW.approval_idempotency_sha256 IS NULL;
  INSERT INTO postiz_effect_outbox (
    effect_id, tenant_id, intent_id, operation, provider, requested_by_user_id,
    idempotency_key_sha256, request_fingerprint_sha256, state, attempt_count,
    created_at, updated_at
  ) VALUES (
    NEW.submission_effect_id, NEW.tenant_id, NEW.intent_id, 'submit', NEW.provider,
    NEW.approved_by_user_id, NEW.approval_idempotency_sha256,
    NEW.intent_fingerprint_sha256, 'pending', 0, NEW.updated_at, NEW.updated_at
  );
END;

CREATE TRIGGER postiz_intents_stop_outbox
AFTER UPDATE OF state ON postiz_intents
WHEN OLD.state IN ('submitted', 'reconciliation_required') AND NEW.state = 'stop_submitted' BEGIN
  SELECT RAISE(ABORT, 'postiz_stop_request_required')
  WHERE NEW.published_observed_at IS NOT NULL
    OR NEW.stop_requested_by_user_id IS NULL
    OR NEW.stop_requested_at IS NULL
    OR NEW.stop_idempotency_sha256 IS NULL;
  INSERT INTO postiz_effect_outbox (
    effect_id, tenant_id, intent_id, operation, provider, requested_by_user_id,
    idempotency_key_sha256, request_fingerprint_sha256, state, attempt_count,
    created_at, updated_at
  ) VALUES (
    NEW.stop_effect_id, NEW.tenant_id, NEW.intent_id, 'stop', NEW.provider,
    NEW.stop_requested_by_user_id, NEW.stop_idempotency_sha256,
    NEW.intent_fingerprint_sha256, 'pending', 0, NEW.updated_at, NEW.updated_at
  );
END;
