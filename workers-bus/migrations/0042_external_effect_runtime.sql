-- 0042_external_effect_runtime.sql - provider-neutral external effect ledger.
--
-- The ledger stores intent, authority, hashes, provider identifiers and
-- reconciliation state only. Provider payloads and credentials remain in the
-- adapter/provider boundary. The business idempotency key is stable for the
-- intent; each dispatch gets a new append-only attempt identity.

CREATE TABLE external_effects (
  effect_id TEXT PRIMARY KEY CHECK (length(effect_id) BETWEEN 16 AND 160),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 128),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'worker', 'customer', 'external_authority', 'device', 'owner')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 160),
  authority_ref TEXT NOT NULL CHECK (length(authority_ref) BETWEEN 1 AND 280),
  policy_ref TEXT NOT NULL CHECK (length(policy_ref) BETWEEN 1 AND 280),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 80),
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 120),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 160),
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
  intent_id TEXT NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 160),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  envelope_hash TEXT NOT NULL CHECK (length(envelope_hash) = 64 AND envelope_hash NOT GLOB '*[^0-9a-f]*'),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 120),
  provider_account_ref TEXT CHECK (provider_account_ref IS NULL OR length(provider_account_ref) BETWEEN 1 AND 160),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 280),
  deadline_at TEXT NOT NULL CHECK (length(deadline_at) BETWEEN 20 AND 40),
  lease_expires_at TEXT,
  preconditions_json TEXT NOT NULL CHECK (length(preconditions_json) BETWEEN 2 AND 32768),
  evidence_refs_json TEXT NOT NULL CHECK (length(evidence_refs_json) BETWEEN 2 AND 32768),
  expected_readback_json TEXT NOT NULL CHECK (length(expected_readback_json) BETWEEN 2 AND 32768),
  retry_limit INTEGER NOT NULL CHECK (retry_limit BETWEEN 0 AND 20),
  compensation_plan_json TEXT NOT NULL CHECK (length(compensation_plan_json) BETWEEN 2 AND 32768),
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) BETWEEN 8 AND 160),
  parent_effect_id TEXT,
  compensates_effect_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'proposed', 'authorized', 'executing', 'reconciling', 'succeeded',
    'failed', 'unknown', 'reconciled', 'retry', 'compensating',
    'compensated', 'manual_exception'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_external_id TEXT,
  provider_response_hash TEXT CHECK (provider_response_hash IS NULL OR (length(provider_response_hash) = 64 AND provider_response_hash NOT GLOB '*[^0-9a-f]*')),
  readback_hash TEXT CHECK (readback_hash IS NULL OR (length(readback_hash) = 64 AND readback_hash NOT GLOB '*[^0-9a-f]*')),
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 160),
  exception_ref TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (parent_effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT,
  FOREIGN KEY (compensates_effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT
);

CREATE INDEX external_effects_due
  ON external_effects (tenant_id, state, deadline_at, updated_at);
CREATE INDEX external_effects_aggregate
  ON external_effects (tenant_id, aggregate_type, aggregate_id, created_at);
CREATE UNIQUE INDEX external_effects_one_compensation
  ON external_effects (compensates_effect_id)
  WHERE compensates_effect_id IS NOT NULL;

CREATE TABLE external_effect_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 16 AND 200),
  effect_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  business_idempotency_key TEXT NOT NULL CHECK (length(business_idempotency_key) BETWEEN 8 AND 280),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('executing', 'reconciling', 'succeeded', 'failed', 'unknown', 'reconciled')),
  provider_external_id TEXT,
  provider_response_hash TEXT CHECK (provider_response_hash IS NULL OR (length(provider_response_hash) = 64 AND provider_response_hash NOT GLOB '*[^0-9a-f]*')),
  readback_hash TEXT CHECK (readback_hash IS NULL OR (length(readback_hash) = 64 AND readback_hash NOT GLOB '*[^0-9a-f]*')),
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 160),
  started_at TEXT NOT NULL CHECK (length(started_at) BETWEEN 20 AND 40),
  ended_at TEXT,
  UNIQUE (effect_id, attempt_number),
  FOREIGN KEY (effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT
);

CREATE INDEX external_effect_attempts_effect
  ON external_effect_attempts (effect_id, attempt_number);

CREATE TABLE external_effect_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'proposed', 'authorized', 'executing', 'reconciling', 'succeeded',
    'failed', 'unknown', 'reconciled', 'retry', 'compensating',
    'compensated', 'manual_exception'
  )),
  from_state TEXT,
  to_state TEXT NOT NULL,
  attempt_id TEXT,
  detail_code TEXT,
  evidence_hash TEXT,
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  UNIQUE (effect_id, event_type, attempt_id),
  FOREIGN KEY (effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES external_effect_attempts(attempt_id) ON DELETE RESTRICT
);

CREATE INDEX external_effect_events_tenant
  ON external_effect_events (tenant_id, occurred_at, event_seq);

CREATE TABLE external_effect_exceptions (
  exception_id TEXT PRIMARY KEY CHECK (length(exception_id) BETWEEN 16 AND 200),
  effect_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 160),
  expected_hash TEXT,
  observed_hash TEXT,
  evidence_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  resolution_ref TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  resolved_at TEXT,
  UNIQUE (effect_id, reason_code, status),
  FOREIGN KEY (effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT
);

CREATE INDEX external_effect_exceptions_open
  ON external_effect_exceptions (tenant_id, status, created_at);

CREATE TRIGGER external_effect_attempt_binding_guard
BEFORE UPDATE ON external_effect_attempts BEGIN
  SELECT RAISE(ABORT, 'external_effect_attempt_binding_immutable')
    WHERE NEW.attempt_id != OLD.attempt_id
       OR NEW.effect_id != OLD.effect_id
       OR NEW.attempt_number != OLD.attempt_number
       OR NEW.business_idempotency_key != OLD.business_idempotency_key
       OR NEW.request_hash != OLD.request_hash
       OR NEW.started_at != OLD.started_at;
  SELECT RAISE(ABORT, 'external_effect_attempt_terminal')
    WHERE OLD.state IN ('succeeded', 'failed', 'unknown', 'reconciled');
  SELECT RAISE(ABORT, 'external_effect_attempt_invalid_transition')
    WHERE NOT (
      (OLD.state = 'executing' AND NEW.state IN ('reconciling', 'failed', 'unknown')) OR
      (OLD.state = 'reconciling' AND NEW.state IN ('succeeded', 'failed', 'unknown'))
    );
  SELECT RAISE(ABORT, 'external_effect_attempt_evidence_immutable')
    WHERE (OLD.provider_external_id IS NOT NULL AND NEW.provider_external_id IS NOT OLD.provider_external_id)
       OR (OLD.provider_response_hash IS NOT NULL AND NEW.provider_response_hash IS NOT OLD.provider_response_hash)
       OR (OLD.readback_hash IS NOT NULL AND NEW.readback_hash IS NOT OLD.readback_hash)
       OR (OLD.result_code IS NOT NULL AND NEW.result_code IS NOT OLD.result_code)
       OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT OLD.ended_at);
END;
CREATE TRIGGER external_effect_attempts_append_only_delete
BEFORE DELETE ON external_effect_attempts BEGIN
  SELECT RAISE(ABORT, 'external_effect_attempts_append_only');
END;
CREATE TRIGGER external_effect_events_append_only_update
BEFORE UPDATE ON external_effect_events BEGIN
  SELECT RAISE(ABORT, 'external_effect_events_append_only');
END;
CREATE TRIGGER external_effect_events_append_only_delete
BEFORE DELETE ON external_effect_events BEGIN
  SELECT RAISE(ABORT, 'external_effect_events_append_only');
END;
CREATE TRIGGER external_effect_exceptions_append_only_delete
BEFORE DELETE ON external_effect_exceptions BEGIN
  SELECT RAISE(ABORT, 'external_effect_exceptions_retained');
END;

CREATE TRIGGER external_effect_binding_guard
BEFORE UPDATE ON external_effects BEGIN
  SELECT RAISE(ABORT, 'external_effect_binding_immutable')
    WHERE NEW.effect_id != OLD.effect_id
       OR NEW.tenant_id != OLD.tenant_id
       OR NEW.actor_type != OLD.actor_type
       OR NEW.actor_id != OLD.actor_id
       OR NEW.task_id != OLD.task_id
       OR NEW.authority_ref != OLD.authority_ref
       OR NEW.policy_ref != OLD.policy_ref
       OR NEW.policy_version != OLD.policy_version
       OR NEW.aggregate_type != OLD.aggregate_type
       OR NEW.aggregate_id != OLD.aggregate_id
       OR NEW.aggregate_version != OLD.aggregate_version
       OR NEW.intent_id != OLD.intent_id
       OR NEW.action != OLD.action
       OR NEW.request_hash != OLD.request_hash
       OR NEW.envelope_hash != OLD.envelope_hash
       OR NEW.provider != OLD.provider
       OR NEW.provider_account_ref IS NOT OLD.provider_account_ref
       OR NEW.idempotency_key != OLD.idempotency_key
       OR NEW.deadline_at != OLD.deadline_at
       OR NEW.preconditions_json != OLD.preconditions_json
       OR NEW.evidence_refs_json != OLD.evidence_refs_json
       OR NEW.expected_readback_json != OLD.expected_readback_json
       OR NEW.retry_limit != OLD.retry_limit
       OR NEW.compensation_plan_json != OLD.compensation_plan_json
       OR NEW.correlation_id != OLD.correlation_id
       OR NEW.parent_effect_id IS NOT OLD.parent_effect_id
       OR NEW.compensates_effect_id IS NOT OLD.compensates_effect_id
       OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'external_effect_terminal')
    WHERE OLD.state IN ('compensated', 'manual_exception') AND NEW.state != OLD.state;
  SELECT RAISE(ABORT, 'external_effect_invalid_transition')
    WHERE NOT (
      (OLD.state = 'proposed' AND NEW.state = 'authorized') OR
      (OLD.state = 'authorized' AND NEW.state IN ('executing', 'failed')) OR
      (OLD.state = 'executing' AND NEW.state IN ('reconciling', 'failed', 'unknown')) OR
      (OLD.state = 'reconciling' AND NEW.state IN ('succeeded', 'failed', 'unknown', 'manual_exception')) OR
      (OLD.state = 'failed' AND NEW.state IN ('reconciled', 'retry', 'manual_exception')) OR
      (OLD.state = 'unknown' AND NEW.state IN ('succeeded', 'reconciled', 'manual_exception')) OR
      (OLD.state = 'reconciled' AND NEW.state IN ('retry', 'manual_exception')) OR
      (OLD.state = 'retry' AND NEW.state = 'executing') OR
      (OLD.state = 'succeeded' AND NEW.state = 'compensating') OR
      (OLD.state = 'compensating' AND NEW.state = 'compensated')
    );
END;

-- A state transition and its current-attempt projection are one SQLite
-- transaction. Terminal attempt evidence is never rewritten by later
-- reconciliation of the parent effect.
CREATE TRIGGER external_effect_attempt_projection
AFTER UPDATE OF state ON external_effects
WHEN OLD.state IN ('executing', 'reconciling')
 AND NEW.state IN ('reconciling', 'succeeded', 'failed', 'unknown', 'manual_exception')
 AND NEW.attempt_count > 0 BEGIN
  UPDATE external_effect_attempts
     SET state = CASE
           WHEN NEW.state = 'reconciling' THEN 'reconciling'
           WHEN NEW.state = 'succeeded' THEN 'succeeded'
           WHEN NEW.state = 'failed' THEN 'failed'
           ELSE 'unknown'
         END,
         provider_external_id = COALESCE(NEW.provider_external_id, provider_external_id),
         provider_response_hash = COALESCE(NEW.provider_response_hash, provider_response_hash),
         readback_hash = COALESCE(NEW.readback_hash, readback_hash),
         result_code = COALESCE(NEW.result_code, result_code),
         ended_at = CASE WHEN NEW.state = 'reconciling' THEN ended_at ELSE COALESCE(ended_at, NEW.updated_at) END
   WHERE effect_id = NEW.effect_id
     AND attempt_number = NEW.attempt_count;
  SELECT RAISE(ABORT, 'external_effect_attempt_projection_missing')
    WHERE changes() != 1;
END;

CREATE TRIGGER external_effect_state_event
AFTER UPDATE OF state ON external_effects BEGIN
  INSERT INTO external_effect_events (
    effect_id, tenant_id, event_type, from_state, to_state, attempt_id,
    detail_code, evidence_hash, occurred_at
  ) VALUES (
    NEW.effect_id, NEW.tenant_id, NEW.state, OLD.state, NEW.state,
    NULL, NEW.result_code, NEW.readback_hash, NEW.updated_at
  );
END;

CREATE TRIGGER external_effect_proposed_event
AFTER INSERT ON external_effects BEGIN
  INSERT INTO external_effect_events (
    effect_id, tenant_id, event_type, from_state, to_state, attempt_id,
    detail_code, evidence_hash, occurred_at
  ) VALUES (
    NEW.effect_id, NEW.tenant_id, 'proposed', NULL, NEW.state, NULL, NULL, NULL, NEW.created_at
  );
END;
