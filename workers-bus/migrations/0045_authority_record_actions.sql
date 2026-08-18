-- 0045_authority_record_actions.sql - governed PWA/MCP authority commands and issuer readbacks.
--
-- Frappe's Authority Record is the normalized tenant-scoped business record.  D1 stores only
-- the owned command/reconciliation ledger: it makes retries and issuer observations durable
-- without treating an agent assertion, app session, or System Manager role as authority truth.
-- Raw evidence remains in its approved evidence store; these rows retain references and hashes.

CREATE TABLE IF NOT EXISTS authority_record_actions (
  action_id TEXT PRIMARY KEY CHECK (
    length(action_id) BETWEEN 12 AND 160
    AND action_id GLOB '[A-Za-z0-9]*'
    AND action_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  authority_record_id TEXT NOT NULL CHECK (
    length(authority_record_id) BETWEEN 3 AND 140
    AND authority_record_id GLOB '[A-Za-z0-9]*'
    AND authority_record_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  operation TEXT NOT NULL CHECK (
    operation IN ('record', 'verify', 'renew', 'supersede', 'revoke', 'resolve_exception')
  ),
  expected_version INTEGER CHECK (expected_version IS NULL OR expected_version BETWEEN 1 AND 1000000),
  idempotency_key_sha256 TEXT NOT NULL CHECK (
    length(idempotency_key_sha256) = 64
    AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  actor_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'applied', 'rejected', 'conflict', 'reconciliation_required')
  ),
  result_json TEXT,
  rejection_code TEXT CHECK (rejection_code IS NULL OR length(rejection_code) BETWEEN 3 AND 120),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key_sha256),
  UNIQUE (action_id, tenant_id),
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_authority_record_actions_tenant_record
  ON authority_record_actions (tenant_id, authority_record_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_authority_record_actions_pending
  ON authority_record_actions (tenant_id, status, updated_at);

CREATE TRIGGER IF NOT EXISTS authority_record_actions_validate_actor
BEFORE INSERT ON authority_record_actions
BEGIN
  SELECT RAISE(ABORT, 'authority_record_business_actor_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM app_users AS actor
    WHERE actor.user_id = NEW.actor_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND actor.role IN ('owner', 'ops')
  );
END;

CREATE TRIGGER IF NOT EXISTS authority_record_actions_identity_immutable
BEFORE UPDATE ON authority_record_actions
BEGIN
  SELECT RAISE(ABORT, 'authority_record_action_identity_immutable')
  WHERE NEW.action_id != OLD.action_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.authority_record_id != OLD.authority_record_id
     OR NEW.operation != OLD.operation
     OR NEW.expected_version IS NOT OLD.expected_version
     OR NEW.idempotency_key_sha256 != OLD.idempotency_key_sha256
     OR NEW.request_fingerprint_sha256 != OLD.request_fingerprint_sha256
     OR NEW.actor_user_id != OLD.actor_user_id
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'authority_record_action_transition_invalid')
  WHERE OLD.status != 'pending'
    OR NEW.status NOT IN ('applied', 'rejected', 'conflict', 'reconciliation_required');

  SELECT RAISE(ABORT, 'authority_record_action_completion_time_required')
  WHERE NEW.status != 'pending' AND NEW.completed_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS authority_record_actions_append_only_delete
BEFORE DELETE ON authority_record_actions
BEGIN
  SELECT RAISE(ABORT, 'authority_record_actions_retained');
END;

CREATE TABLE IF NOT EXISTS authority_record_readbacks (
  readback_id TEXT PRIMARY KEY CHECK (
    length(readback_id) BETWEEN 12 AND 160
    AND readback_id GLOB '[A-Za-z0-9]*'
    AND readback_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  authority_record_id TEXT NOT NULL CHECK (
    length(authority_record_id) BETWEEN 3 AND 140
    AND authority_record_id GLOB '[A-Za-z0-9]*'
    AND authority_record_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  authority_version INTEGER NOT NULL CHECK (authority_version BETWEEN 1 AND 1000000),
  issuer_name TEXT NOT NULL CHECK (length(trim(issuer_name)) BETWEEN 2 AND 200),
  issuer_jurisdiction TEXT NOT NULL CHECK (length(trim(issuer_jurisdiction)) BETWEEN 2 AND 160),
  issuer_reference TEXT NOT NULL CHECK (length(trim(issuer_reference)) BETWEEN 3 AND 240),
  issuer_source_version TEXT NOT NULL CHECK (length(trim(issuer_source_version)) BETWEEN 1 AND 120),
  verification_state TEXT NOT NULL CHECK (
    verification_state IN ('verified', 'revoked', 'contradictory', 'unavailable')
  ),
  evidence_refs_json TEXT NOT NULL CHECK (length(trim(evidence_refs_json)) BETWEEN 2 AND 20000),
  evidence_sha256 TEXT NOT NULL CHECK (
    length(evidence_sha256) = 64
    AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  authority_state_digest_sha256 TEXT NOT NULL CHECK (
    length(authority_state_digest_sha256) = 64
    AND authority_state_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_by_user_id TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 20 AND 40),
  observation_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(observation_fingerprint_sha256) = 64
    AND observation_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  action_id TEXT,
  UNIQUE (tenant_id, authority_record_id, authority_version, evidence_sha256),
  UNIQUE (readback_id, tenant_id),
  FOREIGN KEY (observed_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (action_id, tenant_id)
    REFERENCES authority_record_actions(action_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_authority_record_readbacks_tenant_record
  ON authority_record_readbacks (tenant_id, authority_record_id, authority_version, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_authority_record_readbacks_state
  ON authority_record_readbacks (tenant_id, verification_state, observed_at DESC);

CREATE TRIGGER IF NOT EXISTS authority_record_readbacks_validate_actor
BEFORE INSERT ON authority_record_readbacks
BEGIN
  SELECT RAISE(ABORT, 'authority_record_business_actor_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM app_users AS actor
    WHERE actor.user_id = NEW.observed_by_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND actor.role IN ('owner', 'ops')
  );
  SELECT RAISE(ABORT, 'authority_record_readback_action_tenant_mismatch')
  WHERE NEW.action_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM authority_record_actions AS action
      WHERE action.action_id = NEW.action_id
      AND action.tenant_id = NEW.tenant_id
      AND action.authority_record_id = NEW.authority_record_id
    );
  SELECT RAISE(ABORT, 'authority_record_readback_version_mismatch')
    WHERE NEW.action_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM authority_record_actions AS action
      WHERE action.action_id = NEW.action_id
        AND action.tenant_id = NEW.tenant_id
        AND action.expected_version IS NOT NULL
        AND action.expected_version != NEW.authority_version
    );
END;

CREATE TRIGGER IF NOT EXISTS authority_record_readbacks_append_only_update
BEFORE UPDATE ON authority_record_readbacks
BEGIN
  SELECT RAISE(ABORT, 'authority_record_readbacks_append_only');
END;

CREATE TRIGGER IF NOT EXISTS authority_record_readbacks_append_only_delete
BEFORE DELETE ON authority_record_readbacks
BEGIN
  SELECT RAISE(ABORT, 'authority_record_readbacks_retained');
END;
