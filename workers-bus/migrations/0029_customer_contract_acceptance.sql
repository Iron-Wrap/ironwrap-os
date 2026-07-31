-- 0029_customer_contract_acceptance.sql - email-verified, single-use customer contract acceptance.
--
-- The portal bearer remains read-only.  A separately emailed challenge is bound to that active
-- portal link and to the exact Frappe-published contract anchors.  D1 never stores raw portal or
-- email-challenge tokens, customer email, or an Idempotency-Key; only SHA-256 identities are kept.

CREATE TABLE IF NOT EXISTS customer_portal_acceptance_challenges (
  challenge_id TEXT PRIMARY KEY CHECK (
    length(challenge_id) BETWEEN 20 AND 100
    AND challenge_id GLOB 'acceptance_challenge_[0-9a-f]*'
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  portal_link_id TEXT NOT NULL CHECK (length(portal_link_id) BETWEEN 12 AND 80),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 3 AND 140),
  customer_id TEXT NOT NULL CHECK (length(customer_id) BETWEEN 3 AND 140),
  email_hash TEXT NOT NULL CHECK (
    length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'
  ),
  quote_id TEXT NOT NULL CHECK (length(quote_id) BETWEEN 3 AND 140),
  quote_version INTEGER NOT NULL CHECK (quote_version >= 1),
  proposal_pack_id TEXT NOT NULL CHECK (length(proposal_pack_id) BETWEEN 3 AND 140),
  terms_hash TEXT NOT NULL CHECK (
    length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'
  ),
  terms_json TEXT NOT NULL CHECK (length(terms_json) BETWEEN 2 AND 48000),
  request_ip_hash TEXT NOT NULL CHECK (length(request_ip_hash) = 64),
  request_user_agent_hash TEXT NOT NULL CHECK (length(request_user_agent_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending_delivery', 'sent', 'consumed', 'invalidated')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  provider_message_id TEXT CHECK (
    provider_message_id IS NULL OR (
      length(provider_message_id) BETWEEN 1 AND 255
      AND provider_message_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  consumed_at TEXT,
  invalidated_at TEXT,
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'pending_delivery' AND sent_at IS NULL AND consumed_at IS NULL AND invalidated_at IS NULL)
    OR (state = 'sent' AND sent_at IS NOT NULL AND provider_message_id IS NOT NULL
      AND consumed_at IS NULL AND invalidated_at IS NULL)
    OR (state = 'consumed' AND sent_at IS NOT NULL AND provider_message_id IS NOT NULL
      AND consumed_at IS NOT NULL AND invalidated_at IS NULL)
    OR (state = 'invalidated' AND consumed_at IS NULL AND invalidated_at IS NOT NULL)
  ),
  FOREIGN KEY (portal_link_id) REFERENCES customer_portal_links(link_id) ON DELETE RESTRICT
);

-- At most one email challenge may remain deliverable for a portal link. A new request atomically
-- invalidates the older challenge before creating its replacement.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_portal_acceptance_one_active_challenge
  ON customer_portal_acceptance_challenges (portal_link_id)
  WHERE state IN ('pending_delivery', 'sent');

CREATE INDEX IF NOT EXISTS idx_customer_portal_acceptance_challenges_expiry
  ON customer_portal_acceptance_challenges (state, expires_at);

CREATE TABLE IF NOT EXISTS customer_portal_acceptance_intents (
  acceptance_id TEXT PRIMARY KEY CHECK (
    length(acceptance_id) BETWEEN 16 AND 100
    AND acceptance_id GLOB 'acceptance_[0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  challenge_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  portal_link_id TEXT NOT NULL CHECK (length(portal_link_id) BETWEEN 12 AND 80),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 3 AND 140),
  customer_id TEXT NOT NULL CHECK (length(customer_id) BETWEEN 3 AND 140),
  email_hash TEXT NOT NULL CHECK (
    length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'
  ),
  quote_id TEXT NOT NULL CHECK (length(quote_id) BETWEEN 3 AND 140),
  quote_version INTEGER NOT NULL CHECK (quote_version >= 1),
  proposal_pack_id TEXT NOT NULL CHECK (length(proposal_pack_id) BETWEEN 3 AND 140),
  terms_hash TEXT NOT NULL CHECK (
    length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'
  ),
  terms_json TEXT NOT NULL CHECK (length(terms_json) BETWEEN 2 AND 48000),
  signer_name TEXT NOT NULL CHECK (length(signer_name) BETWEEN 1 AND 160),
  signer_ip_hash TEXT NOT NULL CHECK (length(signer_ip_hash) = 64),
  accepted_at TEXT NOT NULL,
  receipt_key TEXT NOT NULL UNIQUE CHECK (
    receipt_key GLOB 'customer-contract-acceptance/v1/*'
    AND receipt_key NOT GLOB '*..*'
    AND length(receipt_key) BETWEEN 44 AND 240
  ),
  receipt_hash TEXT CHECK (
    receipt_hash IS NULL OR (length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*')
  ),
  receipt_content_length INTEGER CHECK (
    receipt_content_length IS NULL OR receipt_content_length BETWEEN 2 AND 64000
  ),
  state TEXT NOT NULL CHECK (state IN ('receipt_pending', 'receipt_stored', 'accepted', 'uncertain', 'rejected')),
  frappe_attempted_at TEXT,
  frappe_attempt_lease_expires_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR length(result_json) BETWEEN 2 AND 2048),
  response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 3 AND 120
      AND error_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    state != 'receipt_pending'
    OR (receipt_hash IS NULL AND receipt_content_length IS NULL AND frappe_attempted_at IS NULL
      AND frappe_attempt_lease_expires_at IS NULL AND result_json IS NULL AND response_status IS NULL
      AND error_code IS NULL AND completed_at IS NULL)
  ),
  CHECK (
    state != 'receipt_stored'
    OR (receipt_hash IS NOT NULL AND receipt_content_length IS NOT NULL AND result_json IS NULL
      AND response_status IS NULL AND error_code IS NULL AND completed_at IS NULL)
  ),
  CHECK (
    state NOT IN ('accepted', 'uncertain', 'rejected')
    OR (receipt_hash IS NOT NULL AND receipt_content_length IS NOT NULL AND frappe_attempted_at IS NOT NULL
      AND frappe_attempt_lease_expires_at IS NULL AND result_json IS NOT NULL AND response_status IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  CHECK (state != 'accepted' OR (response_status = 200 AND error_code IS NULL)),
  CHECK (state != 'uncertain' OR (response_status = 202 AND error_code IS NOT NULL)),
  CHECK (state != 'rejected' OR (response_status BETWEEN 400 AND 499 AND error_code IS NOT NULL)),
  CHECK (frappe_attempt_lease_expires_at IS NULL OR frappe_attempt_lease_expires_at > frappe_attempted_at),
  FOREIGN KEY (challenge_id) REFERENCES customer_portal_acceptance_challenges(challenge_id) ON DELETE RESTRICT,
  FOREIGN KEY (portal_link_id) REFERENCES customer_portal_links(link_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_customer_portal_acceptance_intents_state_lease
  ON customer_portal_acceptance_intents (state, frappe_attempt_lease_expires_at, updated_at);

CREATE TABLE IF NOT EXISTS customer_portal_acceptance_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  acceptance_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('intent_recorded', 'receipt_stored', 'frappe_commit_attempted', 'accepted', 'uncertain', 'rejected')
  ),
  state TEXT NOT NULL CHECK (state IN ('receipt_pending', 'receipt_stored', 'accepted', 'uncertain', 'rejected')),
  detail_code TEXT CHECK (
    detail_code IS NULL OR (
      length(detail_code) BETWEEN 3 AND 120
      AND detail_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  created_at TEXT NOT NULL,
  UNIQUE (acceptance_id, event_type),
  FOREIGN KEY (acceptance_id) REFERENCES customer_portal_acceptance_intents(acceptance_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_customer_portal_acceptance_events_created
  ON customer_portal_acceptance_events (created_at DESC, event_id DESC);

-- Challenge anchors are the authoritative issuance snapshot. Only the bounded delivery and
-- terminal consumption/invalidating transitions may ever alter a row after creation.
CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_challenge_immutable
BEFORE UPDATE ON customer_portal_acceptance_challenges
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_acceptance_challenge_immutable')
    WHERE NEW.challenge_id IS NOT OLD.challenge_id
      OR NEW.token_hash IS NOT OLD.token_hash
      OR NEW.tenant_id IS NOT OLD.tenant_id
      OR NEW.portal_link_id IS NOT OLD.portal_link_id
      OR NEW.roof_job_id IS NOT OLD.roof_job_id
      OR NEW.customer_id IS NOT OLD.customer_id
      OR NEW.email_hash IS NOT OLD.email_hash
      OR NEW.quote_id IS NOT OLD.quote_id
      OR NEW.quote_version IS NOT OLD.quote_version
      OR NEW.proposal_pack_id IS NOT OLD.proposal_pack_id
      OR NEW.terms_hash IS NOT OLD.terms_hash
      OR NEW.terms_json IS NOT OLD.terms_json
      OR NEW.request_ip_hash IS NOT OLD.request_ip_hash
      OR NEW.request_user_agent_hash IS NOT OLD.request_user_agent_hash
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.expires_at IS NOT OLD.expires_at;
  SELECT RAISE(ABORT, 'customer_portal_acceptance_challenge_invalid_transition')
    WHERE NOT (
      (OLD.state = 'pending_delivery' AND NEW.state IN ('sent', 'invalidated'))
      OR (OLD.state = 'sent' AND NEW.state IN ('consumed', 'invalidated'))
    );
  SELECT RAISE(ABORT, 'customer_portal_acceptance_challenge_delivery_immutable')
    WHERE (NEW.sent_at IS NOT OLD.sent_at OR NEW.provider_message_id IS NOT OLD.provider_message_id)
      AND NOT (OLD.state = 'pending_delivery' AND NEW.state = 'sent');
  SELECT RAISE(ABORT, 'customer_portal_acceptance_challenge_consumption_immutable')
    WHERE NEW.consumed_at IS NOT OLD.consumed_at
      AND NOT (OLD.state = 'sent' AND NEW.state = 'consumed');
  SELECT RAISE(ABORT, 'customer_portal_acceptance_challenge_invalidation_immutable')
    WHERE NEW.invalidated_at IS NOT OLD.invalidated_at
      AND NOT (OLD.state IN ('pending_delivery', 'sent') AND NEW.state = 'invalidated');
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_events_append_only_update
BEFORE UPDATE ON customer_portal_acceptance_events
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_acceptance_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_events_append_only_delete
BEFORE DELETE ON customer_portal_acceptance_events
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_acceptance_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_challenges_append_only_delete
BEFORE DELETE ON customer_portal_acceptance_challenges
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_acceptance_challenges_append_only');
END;

-- Insertion consumes a sent challenge in the same SQLite statement that creates the intent.
-- This closes the otherwise possible race between issuing a replacement email and confirming
-- the old fragment.
CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_consume_challenge
AFTER INSERT ON customer_portal_acceptance_intents
BEGIN
  UPDATE customer_portal_acceptance_challenges
  SET state = 'consumed', consumed_at = NEW.accepted_at
  WHERE challenge_id = NEW.challenge_id AND state = 'sent';

  INSERT INTO customer_portal_acceptance_events
    (acceptance_id, event_type, state, detail_code, created_at)
  VALUES (NEW.acceptance_id, 'intent_recorded', NEW.state, NULL, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_record_state_event
AFTER UPDATE OF state ON customer_portal_acceptance_intents
WHEN OLD.state != NEW.state
BEGIN
  INSERT INTO customer_portal_acceptance_events
    (acceptance_id, event_type, state, detail_code, created_at)
  VALUES (
    NEW.acceptance_id,
    CASE NEW.state
      WHEN 'receipt_stored' THEN 'receipt_stored'
      WHEN 'accepted' THEN 'accepted'
      WHEN 'uncertain' THEN 'uncertain'
      WHEN 'rejected' THEN 'rejected'
    END,
    NEW.state,
    NEW.error_code,
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_record_frappe_attempt
AFTER UPDATE OF frappe_attempted_at ON customer_portal_acceptance_intents
WHEN OLD.frappe_attempted_at IS NULL AND NEW.frappe_attempted_at IS NOT NULL
BEGIN
  INSERT INTO customer_portal_acceptance_events
    (acceptance_id, event_type, state, detail_code, created_at)
  VALUES (NEW.acceptance_id, 'frappe_commit_attempted', NEW.state, NULL, NEW.frappe_attempted_at);
END;

-- Contract anchors and signed attestation are immutable once an intent exists. Only the bounded
-- receipt/attempt/result transition fields may advance thereafter.
CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_immutable_intent
BEFORE UPDATE ON customer_portal_acceptance_intents
WHEN NEW.acceptance_id != OLD.acceptance_id
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.request_fingerprint != OLD.request_fingerprint
  OR NEW.challenge_id != OLD.challenge_id
  OR NEW.tenant_id != OLD.tenant_id
  OR NEW.portal_link_id != OLD.portal_link_id
  OR NEW.roof_job_id != OLD.roof_job_id
  OR NEW.customer_id != OLD.customer_id
  OR NEW.email_hash != OLD.email_hash
  OR NEW.quote_id != OLD.quote_id
  OR NEW.quote_version != OLD.quote_version
  OR NEW.proposal_pack_id != OLD.proposal_pack_id
  OR NEW.terms_hash != OLD.terms_hash
  OR NEW.terms_json != OLD.terms_json
  OR NEW.signer_name != OLD.signer_name
  OR NEW.signer_ip_hash != OLD.signer_ip_hash
  OR NEW.accepted_at != OLD.accepted_at
  OR NEW.receipt_key != OLD.receipt_key
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_acceptance_intent_immutable');
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_valid_transition
BEFORE UPDATE ON customer_portal_acceptance_intents
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_acceptance_invalid_transition')
    WHERE NOT (
      (
        OLD.state = 'receipt_pending'
        AND NEW.state = 'receipt_stored'
        AND NEW.frappe_attempted_at IS NULL
        AND NEW.frappe_attempt_lease_expires_at IS NULL
        AND NEW.result_json IS NULL
        AND NEW.response_status IS NULL
        AND NEW.error_code IS NULL
        AND NEW.completed_at IS NULL
      )
      OR (
        OLD.state = 'receipt_stored'
        AND NEW.state = 'receipt_stored'
        AND OLD.frappe_attempted_at IS NULL
        AND NEW.frappe_attempted_at IS NOT NULL
        AND NEW.frappe_attempt_lease_expires_at IS NOT NULL
        AND NEW.receipt_hash IS OLD.receipt_hash
        AND NEW.receipt_content_length IS OLD.receipt_content_length
        AND NEW.result_json IS OLD.result_json
        AND NEW.response_status IS OLD.response_status
        AND NEW.error_code IS OLD.error_code
        AND NEW.completed_at IS OLD.completed_at
      )
      OR (
        OLD.state = 'receipt_stored'
        AND NEW.state IN ('accepted', 'uncertain', 'rejected')
        AND OLD.frappe_attempted_at IS NOT NULL
        AND NEW.frappe_attempted_at IS OLD.frappe_attempted_at
        AND NEW.receipt_hash IS OLD.receipt_hash
        AND NEW.receipt_content_length IS OLD.receipt_content_length
        AND NEW.frappe_attempt_lease_expires_at IS NULL
        AND NEW.result_json IS NOT NULL
        AND NEW.response_status IS NOT NULL
        AND NEW.completed_at IS NOT NULL
      )
    );
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_acceptance_intents_append_only_delete
BEFORE DELETE ON customer_portal_acceptance_intents
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_acceptance_intents_append_only');
END;
