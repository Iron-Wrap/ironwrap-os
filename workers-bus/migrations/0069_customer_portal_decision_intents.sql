-- 0069_customer_portal_decision_intents.sql - provisional customer material/colour selection.
--
-- Structurally this is 0029's acceptance-intent machine with the email challenge removed. That
-- removal is the whole point: accepting a contract is a legal act and earns a second, email-bound
-- token; choosing a colour is a preference the estimator still confirms before any price moves,
-- and demanding an email round-trip for it would destroy the interaction this table exists to
-- record. What is kept from 0029 is everything that makes the write safe to retry: one row per
-- Idempotency-Key, an immutable R2 receipt recorded before the Frappe effect is attempted, a
-- single-attempt lease, and a terminal result replayed verbatim to a repeated request.
--
-- D1 never stores the raw portal token or the Idempotency-Key; only SHA-256 identities are kept.

CREATE TABLE IF NOT EXISTS customer_portal_decision_intents (
  decision_id TEXT PRIMARY KEY CHECK (
    length(decision_id) BETWEEN 16 AND 100
    AND decision_id GLOB 'decision_[0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  portal_link_id TEXT NOT NULL CHECK (length(portal_link_id) BETWEEN 12 AND 80),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 3 AND 140),
  customer_id TEXT NOT NULL CHECK (length(customer_id) BETWEEN 3 AND 140),
  option_package_id TEXT NOT NULL CHECK (length(option_package_id) BETWEEN 3 AND 140),
  option_tier TEXT CHECK (
    option_tier IS NULL OR option_tier IN ('Good', 'Better', 'Best', 'Custom')
  ),
  option_label TEXT NOT NULL CHECK (length(option_label) BETWEEN 1 AND 200),
  selected_at TEXT NOT NULL,
  selector_ip_hash TEXT NOT NULL CHECK (length(selector_ip_hash) = 64),
  receipt_key TEXT NOT NULL UNIQUE CHECK (
    receipt_key GLOB 'customer-portal-decision/v1/*'
    AND receipt_key NOT GLOB '*..*'
    AND length(receipt_key) BETWEEN 40 AND 240
  ),
  receipt_hash TEXT CHECK (
    receipt_hash IS NULL OR (length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*')
  ),
  receipt_content_length INTEGER CHECK (
    receipt_content_length IS NULL OR receipt_content_length BETWEEN 2 AND 64000
  ),
  state TEXT NOT NULL CHECK (
    state IN ('receipt_pending', 'receipt_stored', 'recorded', 'uncertain', 'rejected')
  ),
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
    state NOT IN ('recorded', 'uncertain', 'rejected')
    OR (receipt_hash IS NOT NULL AND receipt_content_length IS NOT NULL AND frappe_attempted_at IS NOT NULL
      AND frappe_attempt_lease_expires_at IS NULL AND result_json IS NOT NULL AND response_status IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  CHECK (state != 'recorded' OR (response_status = 200 AND error_code IS NULL)),
  CHECK (state != 'uncertain' OR (response_status = 202 AND error_code IS NOT NULL)),
  CHECK (state != 'rejected' OR (response_status BETWEEN 400 AND 499 AND error_code IS NOT NULL)),
  CHECK (frappe_attempt_lease_expires_at IS NULL OR frappe_attempt_lease_expires_at > frappe_attempted_at),
  FOREIGN KEY (portal_link_id) REFERENCES customer_portal_links(link_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_customer_portal_decision_intents_state_lease
  ON customer_portal_decision_intents (state, frappe_attempt_lease_expires_at, updated_at);

-- A customer may revise a preference, so a link carries many decisions over time. The portal
-- reads the newest one back to show which card is currently selected.
CREATE INDEX IF NOT EXISTS idx_customer_portal_decision_intents_link_recent
  ON customer_portal_decision_intents (portal_link_id, selected_at DESC, decision_id DESC);

CREATE TABLE IF NOT EXISTS customer_portal_decision_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('intent_recorded', 'receipt_stored', 'frappe_commit_attempted', 'recorded', 'uncertain', 'rejected')
  ),
  state TEXT NOT NULL CHECK (
    state IN ('receipt_pending', 'receipt_stored', 'recorded', 'uncertain', 'rejected')
  ),
  detail_code TEXT CHECK (
    detail_code IS NULL OR (
      length(detail_code) BETWEEN 3 AND 120
      AND detail_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  created_at TEXT NOT NULL,
  UNIQUE (decision_id, event_type),
  FOREIGN KEY (decision_id) REFERENCES customer_portal_decision_intents(decision_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_customer_portal_decision_events_created
  ON customer_portal_decision_events (created_at DESC, event_id DESC);

CREATE TRIGGER IF NOT EXISTS customer_portal_decision_events_append_only_update
BEFORE UPDATE ON customer_portal_decision_events
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_decision_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_decision_events_append_only_delete
BEFORE DELETE ON customer_portal_decision_events
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_decision_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_decision_record_intent
AFTER INSERT ON customer_portal_decision_intents
BEGIN
  INSERT INTO customer_portal_decision_events
    (decision_id, event_type, state, detail_code, created_at)
  VALUES (NEW.decision_id, 'intent_recorded', NEW.state, NULL, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_decision_record_state_event
AFTER UPDATE OF state ON customer_portal_decision_intents
WHEN OLD.state != NEW.state
BEGIN
  INSERT INTO customer_portal_decision_events
    (decision_id, event_type, state, detail_code, created_at)
  VALUES (
    NEW.decision_id,
    CASE NEW.state
      WHEN 'receipt_stored' THEN 'receipt_stored'
      WHEN 'recorded' THEN 'recorded'
      WHEN 'uncertain' THEN 'uncertain'
      WHEN 'rejected' THEN 'rejected'
    END,
    NEW.state,
    NEW.error_code,
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_decision_record_frappe_attempt
AFTER UPDATE OF frappe_attempted_at ON customer_portal_decision_intents
WHEN OLD.frappe_attempted_at IS NULL AND NEW.frappe_attempted_at IS NOT NULL
BEGIN
  INSERT INTO customer_portal_decision_events
    (decision_id, event_type, state, detail_code, created_at)
  VALUES (NEW.decision_id, 'frappe_commit_attempted', NEW.state, NULL, NEW.frappe_attempted_at);
END;

-- What the customer chose, and which capability they held when they chose it, is fixed at claim
-- time. Only the bounded receipt/attempt/result fields may advance afterwards.
CREATE TRIGGER IF NOT EXISTS customer_portal_decision_immutable_intent
BEFORE UPDATE ON customer_portal_decision_intents
WHEN NEW.decision_id != OLD.decision_id
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.request_fingerprint != OLD.request_fingerprint
  OR NEW.tenant_id != OLD.tenant_id
  OR NEW.portal_link_id != OLD.portal_link_id
  OR NEW.roof_job_id != OLD.roof_job_id
  OR NEW.customer_id != OLD.customer_id
  OR NEW.option_package_id != OLD.option_package_id
  OR NEW.option_tier IS NOT OLD.option_tier
  OR NEW.option_label != OLD.option_label
  OR NEW.selected_at != OLD.selected_at
  OR NEW.selector_ip_hash != OLD.selector_ip_hash
  OR NEW.receipt_key != OLD.receipt_key
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_decision_intent_immutable');
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_decision_valid_transition
BEFORE UPDATE ON customer_portal_decision_intents
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_decision_invalid_transition')
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
        AND NEW.state IN ('recorded', 'uncertain', 'rejected')
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

CREATE TRIGGER IF NOT EXISTS customer_portal_decision_intents_append_only_delete
BEFORE DELETE ON customer_portal_decision_intents
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_decision_intents_append_only');
END;
