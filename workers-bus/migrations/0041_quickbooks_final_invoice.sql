-- 0041_quickbooks_final_invoice.sql - governed residential final-balance invoice control plane.
--
-- D1 keeps only privacy-bounded accounting references, hashes, encrypted OAuth material, and
-- append-only receipts. QuickBooks create is an outbox effect; an authenticated exact-id
-- readback is a separate effect and is the only path that can reach `matched`.

CREATE TABLE quickbooks_oauth_states (
  state_sha256 TEXT PRIMARY KEY CHECK (
    length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 16 AND 512),
  return_path TEXT NOT NULL CHECK (return_path = '/accounting/quickbooks'),
  idempotency_key_sha256 TEXT NOT NULL CHECK (
    length(idempotency_key_sha256) = 64 AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 24 AND 40),
  consumed_at TEXT CHECK (consumed_at IS NULL OR length(consumed_at) BETWEEN 24 AND 40),
  outcome_code TEXT CHECK (outcome_code IS NULL OR outcome_code IN (
    'exchange_started', 'connected', 'provider_denied', 'exchange_failed', 'exchange_uncertain'
  )),
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key_sha256)
);

CREATE INDEX idx_quickbooks_oauth_states_expiry
  ON quickbooks_oauth_states (tenant_id, expires_at, consumed_at);

CREATE TRIGGER quickbooks_oauth_states_binding_guard
BEFORE UPDATE ON quickbooks_oauth_states BEGIN
  SELECT RAISE(ABORT, 'quickbooks_oauth_state_binding_immutable')
  WHERE NEW.state_sha256 != OLD.state_sha256
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.user_id != OLD.user_id
     OR NEW.redirect_uri != OLD.redirect_uri
     OR NEW.return_path != OLD.return_path
     OR NEW.idempotency_key_sha256 != OLD.idempotency_key_sha256
     OR NEW.request_fingerprint_sha256 != OLD.request_fingerprint_sha256
     OR NEW.created_at != OLD.created_at
     OR NEW.expires_at != OLD.expires_at
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at);
  SELECT RAISE(ABORT, 'quickbooks_oauth_state_consumption_invalid')
  WHERE NEW.consumed_at IS NULL
     OR (OLD.outcome_code IS NULL AND OLD.consumed_at IS NOT NULL)
     OR (OLD.outcome_code IS NULL AND NEW.outcome_code NOT IN ('exchange_started', 'provider_denied'))
     OR (OLD.outcome_code = 'exchange_started' AND OLD.consumed_at IS NULL)
     OR (OLD.outcome_code = 'exchange_started'
       AND NEW.outcome_code NOT IN ('connected', 'exchange_failed', 'exchange_uncertain'))
     OR OLD.outcome_code IN ('connected', 'provider_denied', 'exchange_failed', 'exchange_uncertain');
END;

CREATE TRIGGER quickbooks_oauth_states_no_delete
BEFORE DELETE ON quickbooks_oauth_states BEGIN
  SELECT RAISE(ABORT, 'quickbooks_oauth_states_retained');
END;

CREATE TABLE quickbooks_connections (
  connection_id TEXT PRIMARY KEY CHECK (length(connection_id) = 36),
  oauth_state_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(oauth_state_sha256) = 64 AND oauth_state_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  realm_id TEXT NOT NULL CHECK (
    length(realm_id) BETWEEN 1 AND 32 AND realm_id NOT GLOB '*[^0-9]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('connected', 'revoked', 'reconciliation_required')),
  encrypted_bundle_b64 TEXT NOT NULL CHECK (length(encrypted_bundle_b64) BETWEEN 64 AND 16384),
  bundle_iv_b64 TEXT NOT NULL CHECK (length(bundle_iv_b64) BETWEEN 16 AND 32),
  encryption_key_version TEXT NOT NULL CHECK (length(encryption_key_version) BETWEEN 1 AND 32),
  bundle_version INTEGER NOT NULL CHECK (bundle_version > 0),
  access_expires_at TEXT NOT NULL CHECK (length(access_expires_at) BETWEEN 24 AND 40),
  refresh_expires_at TEXT CHECK (
    refresh_expires_at IS NULL OR length(refresh_expires_at) BETWEEN 24 AND 40
  ),
  refresh_lease_id TEXT CHECK (refresh_lease_id IS NULL OR length(refresh_lease_id) = 36),
  refresh_lease_expires_at TEXT CHECK (
    refresh_lease_expires_at IS NULL OR length(refresh_lease_expires_at) BETWEEN 24 AND 40
  ),
  connected_by_user_id TEXT NOT NULL,
  connected_at TEXT NOT NULL CHECK (length(connected_at) BETWEEN 24 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 24 AND 40),
  revocation_idempotency_sha256 TEXT CHECK (
    revocation_idempotency_sha256 IS NULL OR (
      length(revocation_idempotency_sha256) = 64
      AND revocation_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  revocation_fingerprint_sha256 TEXT CHECK (
    revocation_fingerprint_sha256 IS NULL OR (
      length(revocation_fingerprint_sha256) = 64
      AND revocation_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  revoked_by_user_id TEXT,
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(revoked_at) BETWEEN 24 AND 40),
  FOREIGN KEY (connected_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (oauth_state_sha256)
    REFERENCES quickbooks_oauth_states(state_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (revoked_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, revocation_idempotency_sha256),
  CHECK (
    (state IN ('connected', 'reconciliation_required') AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
      AND revocation_idempotency_sha256 IS NOT NULL
      AND revocation_fingerprint_sha256 IS NOT NULL)
  ),
  CHECK (
    (refresh_lease_id IS NULL AND refresh_lease_expires_at IS NULL)
    OR (refresh_lease_id IS NOT NULL AND refresh_lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX idx_quickbooks_connections_realm
  ON quickbooks_connections (tenant_id, realm_id, connected_at);
CREATE UNIQUE INDEX idx_quickbooks_connections_one_active
  ON quickbooks_connections (tenant_id) WHERE state IN ('connected', 'reconciliation_required');

CREATE TRIGGER quickbooks_connections_identity_guard
BEFORE UPDATE ON quickbooks_connections BEGIN
  SELECT RAISE(ABORT, 'quickbooks_connection_identity_immutable')
  WHERE NEW.connection_id != OLD.connection_id
     OR NEW.oauth_state_sha256 != OLD.oauth_state_sha256
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.realm_id != OLD.realm_id
     OR NEW.connected_at != OLD.connected_at;
  SELECT RAISE(ABORT, 'quickbooks_connection_bundle_version_invalid')
  WHERE NEW.bundle_version < OLD.bundle_version
     OR NEW.bundle_version > OLD.bundle_version + 1;
  SELECT RAISE(ABORT, 'quickbooks_connection_revocation_terminal')
  WHERE OLD.state = 'revoked' AND (
    NEW.state != 'revoked'
    OR NEW.encrypted_bundle_b64 != OLD.encrypted_bundle_b64
    OR NEW.bundle_iv_b64 != OLD.bundle_iv_b64
    OR NEW.encryption_key_version != OLD.encryption_key_version
    OR NEW.bundle_version != OLD.bundle_version
    OR NEW.access_expires_at != OLD.access_expires_at
    OR NEW.refresh_expires_at IS NOT OLD.refresh_expires_at
    OR NEW.refresh_lease_id IS NOT OLD.refresh_lease_id
    OR NEW.refresh_lease_expires_at IS NOT OLD.refresh_lease_expires_at
    OR NEW.connected_by_user_id != OLD.connected_by_user_id
    OR NEW.updated_at != OLD.updated_at
    OR NEW.revocation_idempotency_sha256 IS NOT OLD.revocation_idempotency_sha256
    OR NEW.revocation_fingerprint_sha256 IS NOT OLD.revocation_fingerprint_sha256
    OR NEW.revoked_by_user_id IS NOT OLD.revoked_by_user_id
    OR NEW.revoked_at IS NOT OLD.revoked_at
  );
  SELECT RAISE(ABORT, 'quickbooks_connection_uncertainty_terminal')
  WHERE OLD.state = 'reconciliation_required'
    AND NEW.state NOT IN ('reconciliation_required', 'revoked');
  SELECT RAISE(ABORT, 'quickbooks_connection_revocation_evidence_invalid')
  WHERE (OLD.revocation_idempotency_sha256 IS NOT NULL
       AND NEW.revocation_idempotency_sha256 IS NOT OLD.revocation_idempotency_sha256)
     OR (OLD.revocation_fingerprint_sha256 IS NOT NULL
       AND NEW.revocation_fingerprint_sha256 IS NOT OLD.revocation_fingerprint_sha256);
  SELECT RAISE(ABORT, 'quickbooks_connection_evidence_erasure_forbidden')
  WHERE NEW.encrypted_bundle_b64 = '' OR NEW.bundle_iv_b64 = '';
END;

CREATE TRIGGER quickbooks_connections_no_delete
BEFORE DELETE ON quickbooks_connections BEGIN
  SELECT RAISE(ABORT, 'quickbooks_connections_retained');
END;

CREATE TABLE quickbooks_connection_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  connection_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('connected', 'refreshed', 'refresh_uncertain', 'revoked')),
  bundle_version INTEGER NOT NULL CHECK (bundle_version > 0),
  actor_user_id TEXT,
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 24 AND 40),
  FOREIGN KEY (connection_id) REFERENCES quickbooks_connections(connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_quickbooks_connection_events_connection
  ON quickbooks_connection_events (connection_id, event_seq);

CREATE TRIGGER quickbooks_connection_events_append_only_update
BEFORE UPDATE ON quickbooks_connection_events BEGIN
  SELECT RAISE(ABORT, 'quickbooks_connection_events_append_only');
END;
CREATE TRIGGER quickbooks_connection_events_append_only_delete
BEFORE DELETE ON quickbooks_connection_events BEGIN
  SELECT RAISE(ABORT, 'quickbooks_connection_events_append_only');
END;

CREATE TRIGGER quickbooks_connections_connected_event
AFTER INSERT ON quickbooks_connections BEGIN
  INSERT INTO quickbooks_connection_events (
    tenant_id, connection_id, event_type, bundle_version, actor_user_id, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.connection_id, 'connected', NEW.bundle_version,
    NEW.connected_by_user_id, NEW.connected_at
  );
END;

CREATE TRIGGER quickbooks_connections_refreshed_event
AFTER UPDATE OF bundle_version ON quickbooks_connections
WHEN NEW.bundle_version = OLD.bundle_version + 1 BEGIN
  INSERT INTO quickbooks_connection_events (
    tenant_id, connection_id, event_type, bundle_version, actor_user_id, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.connection_id, 'refreshed', NEW.bundle_version, NULL, NEW.updated_at
  );
END;

CREATE TRIGGER quickbooks_connections_revoked_event
AFTER UPDATE OF state ON quickbooks_connections
WHEN OLD.state IN ('connected', 'reconciliation_required') AND NEW.state = 'revoked' BEGIN
  INSERT INTO quickbooks_connection_events (
    tenant_id, connection_id, event_type, bundle_version, actor_user_id, detail_code, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.connection_id, 'revoked', NEW.bundle_version,
    NEW.revoked_by_user_id, 'removed_from_ironwrap', NEW.updated_at
  );
END;

CREATE TRIGGER quickbooks_connections_refresh_uncertain_event
AFTER UPDATE OF state ON quickbooks_connections
WHEN OLD.state = 'connected' AND NEW.state = 'reconciliation_required' BEGIN
  INSERT INTO quickbooks_connection_events (
    tenant_id, connection_id, event_type, bundle_version, actor_user_id, detail_code, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.connection_id, 'refresh_uncertain', NEW.bundle_version,
    NULL, 'refresh_outcome_uncertain', NEW.updated_at
  );
END;

CREATE TRIGGER quickbooks_connections_connection_lost_intents
AFTER UPDATE OF state ON quickbooks_connections
WHEN OLD.state = 'connected' AND NEW.state IN ('revoked', 'reconciliation_required') BEGIN
  UPDATE quickbooks_final_invoice_intents
     SET state = 'connection_required', blocker_code = 'oauth_connection_required',
         blocker_next_step = 'connect_quickbooks', error_code = 'quickbooks_connection_required',
         version = version + 1, updated_at = NEW.updated_at
   WHERE tenant_id = NEW.tenant_id AND realm_id = NEW.realm_id
     AND state = 'pending_review' AND provider_invoice_id IS NULL;
END;

CREATE TABLE quickbooks_final_invoice_intents (
  intent_id TEXT PRIMARY KEY CHECK (
    length(intent_id) BETWEEN 16 AND 160
    AND intent_id NOT GLOB '*[^A-Za-z0-9:_-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 1 AND 160),
  shop_order_id TEXT CHECK (shop_order_id IS NULL OR length(shop_order_id) BETWEEN 1 AND 160),
  completion_packet_id TEXT NOT NULL CHECK (length(completion_packet_id) BETWEEN 1 AND 160),
  completion_version INTEGER NOT NULL CHECK (completion_version > 0),
  completion_sha256 TEXT NOT NULL CHECK (
    length(completion_sha256) = 64 AND completion_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  customer_quote_id TEXT NOT NULL CHECK (length(customer_quote_id) BETWEEN 1 AND 160),
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  quote_sha256 TEXT NOT NULL CHECK (
    length(quote_sha256) = 64 AND quote_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  changes_sha256 TEXT NOT NULL CHECK (
    length(changes_sha256) = 64 AND changes_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  basis_sha256 TEXT NOT NULL CHECK (
    length(basis_sha256) = 64 AND basis_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(candidate_fingerprint_sha256) = 64
    AND candidate_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  realm_id TEXT NOT NULL CHECK (
    length(realm_id) BETWEEN 1 AND 32 AND realm_id NOT GLOB '*[^0-9]*'
  ),
  customer_ref TEXT NOT NULL CHECK (
    length(customer_ref) BETWEEN 1 AND 32 AND customer_ref NOT GLOB '*[^0-9]*'
  ),
  item_ref TEXT NOT NULL CHECK (
    length(item_ref) BETWEEN 1 AND 32 AND item_ref NOT GLOB '*[^0-9]*'
  ),
  tax_code_ref TEXT NOT NULL CHECK (
    length(tax_code_ref) BETWEEN 1 AND 32 AND tax_code_ref NOT GLOB '*[^0-9]*'
  ),
  terms_ref TEXT NOT NULL CHECK (
    length(terms_ref) BETWEEN 1 AND 32 AND terms_ref NOT GLOB '*[^0-9]*'
  ),
  currency TEXT NOT NULL CHECK (currency = 'CAD'),
  subtotal TEXT NOT NULL CHECK (length(subtotal) BETWEEN 4 AND 12),
  tax_amount TEXT NOT NULL CHECK (length(tax_amount) BETWEEN 4 AND 12),
  total_amount TEXT NOT NULL CHECK (length(total_amount) BETWEEN 4 AND 12),
  already_invoiced TEXT NOT NULL CHECK (length(already_invoiced) BETWEEN 4 AND 12),
  final_balance TEXT NOT NULL CHECK (length(final_balance) BETWEEN 4 AND 12),
  tax_code TEXT NOT NULL CHECK (length(tax_code) BETWEEN 1 AND 40),
  tax_rate TEXT NOT NULL CHECK (length(tax_rate) BETWEEN 1 AND 16),
  invoice_date TEXT NOT NULL CHECK (length(invoice_date) = 10),
  due_date TEXT NOT NULL CHECK (length(due_date) = 10),
  lines_json TEXT NOT NULL CHECK (length(lines_json) BETWEEN 2 AND 32768),
  evidence_json TEXT NOT NULL CHECK (length(evidence_json) BETWEEN 2 AND 32768),
  provider_payload_json TEXT NOT NULL CHECK (length(provider_payload_json) BETWEEN 2 AND 32768),
  provider_payload_sha256 TEXT NOT NULL CHECK (
    length(provider_payload_sha256) = 64
    AND provider_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider_request_id TEXT NOT NULL CHECK (length(provider_request_id) BETWEEN 8 AND 50),
  state TEXT NOT NULL CHECK (state IN (
    'connection_required', 'blocked', 'pending_review', 'rejected',
    'submission_pending', 'submitted', 'matched', 'failed',
    'reconciliation_required'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  blocker_code TEXT CHECK (blocker_code IS NULL OR length(blocker_code) BETWEEN 1 AND 80),
  blocker_next_step TEXT CHECK (
    blocker_next_step IS NULL OR length(blocker_next_step) BETWEEN 1 AND 80
  ),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  approval_idempotency_sha256 TEXT CHECK (
    approval_idempotency_sha256 IS NULL OR (
      length(approval_idempotency_sha256) = 64
      AND approval_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  approval_fingerprint_sha256 TEXT CHECK (
    approval_fingerprint_sha256 IS NULL OR (
      length(approval_fingerprint_sha256) = 64
      AND approval_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  rejection_idempotency_sha256 TEXT CHECK (
    rejection_idempotency_sha256 IS NULL OR (
      length(rejection_idempotency_sha256) = 64
      AND rejection_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  rejection_fingerprint_sha256 TEXT CHECK (
    rejection_fingerprint_sha256 IS NULL OR (
      length(rejection_fingerprint_sha256) = 64
      AND rejection_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  reconcile_idempotency_sha256 TEXT CHECK (
    reconcile_idempotency_sha256 IS NULL OR (
      length(reconcile_idempotency_sha256) = 64
      AND reconcile_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  reconcile_fingerprint_sha256 TEXT CHECK (
    reconcile_fingerprint_sha256 IS NULL OR (
      length(reconcile_fingerprint_sha256) = 64
      AND reconcile_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  approved_by_user_id TEXT,
  approved_at TEXT,
  rejected_by_user_id TEXT,
  rejected_at TEXT,
  provider_invoice_id TEXT CHECK (
    provider_invoice_id IS NULL OR (
      length(provider_invoice_id) BETWEEN 1 AND 32
      AND provider_invoice_id NOT GLOB '*[^0-9]*'
    )
  ),
  provider_invoice_sha256 TEXT CHECK (
    provider_invoice_sha256 IS NULL OR (
      length(provider_invoice_sha256) = 64
      AND provider_invoice_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  provider_submitted_at TEXT CHECK (
    provider_submitted_at IS NULL OR length(provider_submitted_at) BETWEEN 24 AND 40
  ),
  provider_matched_at TEXT CHECK (
    provider_matched_at IS NULL OR length(provider_matched_at) BETWEEN 24 AND 40
  ),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 24 AND 40),
  UNIQUE (tenant_id, roof_job_id, completion_version),
  UNIQUE (tenant_id, basis_sha256),
  UNIQUE (realm_id, provider_request_id),
  UNIQUE (tenant_id, approval_idempotency_sha256),
  UNIQUE (tenant_id, rejection_idempotency_sha256),
  UNIQUE (tenant_id, reconcile_idempotency_sha256),
  FOREIGN KEY (approved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (rejected_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK ((blocker_code IS NULL) = (blocker_next_step IS NULL)),
  CHECK (state != 'blocked' OR blocker_code IS NOT NULL),
  CHECK (state != 'rejected' OR rejected_by_user_id IS NOT NULL),
  CHECK (state NOT IN ('submitted', 'matched') OR provider_invoice_id IS NOT NULL),
  CHECK (state != 'matched' OR provider_matched_at IS NOT NULL)
);

CREATE INDEX idx_quickbooks_final_invoice_actionable
  ON quickbooks_final_invoice_intents (tenant_id, state, updated_at);
CREATE INDEX idx_quickbooks_final_invoice_provider
  ON quickbooks_final_invoice_intents (tenant_id, realm_id, provider_invoice_id);

CREATE TABLE quickbooks_final_invoice_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  intent_version INTEGER NOT NULL CHECK (intent_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'discovered', 'connection_required', 'blocked', 'pending_review', 'approved',
    'rejected', 'submission_pending', 'submitted', 'matched', 'failed',
    'reconciliation_required', 'reconcile_requested'
  )),
  state_from TEXT,
  state_to TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'accounting', 'system')),
  actor_user_id TEXT,
  candidate_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(candidate_fingerprint_sha256) = 64
    AND candidate_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 24 AND 40),
  UNIQUE (intent_id, intent_version),
  FOREIGN KEY (intent_id) REFERENCES quickbooks_final_invoice_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_quickbooks_final_invoice_events_intent
  ON quickbooks_final_invoice_events (intent_id, event_seq);
CREATE TRIGGER quickbooks_final_invoice_events_append_only_update
BEFORE UPDATE ON quickbooks_final_invoice_events BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_events_append_only');
END;
CREATE TRIGGER quickbooks_final_invoice_events_append_only_delete
BEFORE DELETE ON quickbooks_final_invoice_events BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_events_append_only');
END;

CREATE TABLE quickbooks_final_invoice_outbox (
  effect_id TEXT PRIMARY KEY CHECK (length(effect_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'readback', 'bind', 'resolve')),
  idempotency_key_sha256 TEXT NOT NULL CHECK (
    length(idempotency_key_sha256) = 64
    AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider_request_id TEXT CHECK (
    provider_request_id IS NULL OR length(provider_request_id) BETWEEN 8 AND 50
  ),
  provider_payload_sha256 TEXT CHECK (
    provider_payload_sha256 IS NULL OR (
      length(provider_payload_sha256) = 64
      AND provider_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'attempting', 'succeeded', 'failed', 'unknown')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at TEXT CHECK (
    next_attempt_at IS NULL OR length(next_attempt_at) BETWEEN 24 AND 40
  ),
  response_class TEXT CHECK (
    response_class IS NULL OR response_class IN (
      'accepted', 'http_rejected', 'network_unknown', 'invalid_response', 'exact_match',
      'drift', 'missing', 'frappe_accepted', 'frappe_rejected'
    )
  ),
  response_status INTEGER CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  ),
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 24 AND 40),
  UNIQUE (tenant_id, idempotency_key_sha256),
  FOREIGN KEY (intent_id) REFERENCES quickbooks_final_invoice_intents(intent_id) ON DELETE RESTRICT,
  CHECK (
    (operation = 'submit' AND provider_request_id IS NOT NULL AND provider_payload_sha256 IS NOT NULL)
    OR (operation != 'submit' AND provider_request_id IS NULL)
  )
);

CREATE INDEX idx_quickbooks_final_invoice_outbox_pending
  ON quickbooks_final_invoice_outbox (state, next_attempt_at, created_at);

CREATE TRIGGER quickbooks_final_invoice_outbox_attempt_guard
BEFORE UPDATE OF state, attempt_count ON quickbooks_final_invoice_outbox BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_outbox_attempt_invalid')
  WHERE NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1
     OR (NEW.state = 'attempting' AND NEW.attempt_count != OLD.attempt_count + 1)
     OR (NEW.operation = 'submit' AND (
       NEW.provider_request_id != OLD.provider_request_id
       OR NEW.provider_payload_sha256 != OLD.provider_payload_sha256
       OR NEW.request_fingerprint_sha256 != OLD.request_fingerprint_sha256
     ));
END;

CREATE TRIGGER quickbooks_final_invoice_outbox_identity_guard
BEFORE UPDATE ON quickbooks_final_invoice_outbox BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_outbox_identity_immutable')
  WHERE NEW.effect_id != OLD.effect_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.intent_id != OLD.intent_id
     OR NEW.operation != OLD.operation
     OR NEW.idempotency_key_sha256 != OLD.idempotency_key_sha256
     OR NEW.request_fingerprint_sha256 != OLD.request_fingerprint_sha256
     OR NEW.provider_request_id IS NOT OLD.provider_request_id
     OR NEW.provider_payload_sha256 IS NOT OLD.provider_payload_sha256
     OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_outbox_state_invalid')
  WHERE (OLD.state = 'succeeded' AND NEW.state != 'succeeded')
     OR (OLD.state = 'unknown' AND NEW.state != 'unknown')
     OR (OLD.state = 'failed' AND NEW.state IN ('pending', 'attempting'));
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_outbox_terminal_evidence_immutable')
  WHERE OLD.state IN ('succeeded', 'failed', 'unknown') AND (
    NEW.response_class IS NOT OLD.response_class
    OR NEW.response_status IS NOT OLD.response_status
    OR NEW.detail_code IS NOT OLD.detail_code
    OR NEW.updated_at != OLD.updated_at
  );
END;

CREATE TRIGGER quickbooks_final_invoice_outbox_success_guard
BEFORE UPDATE OF state ON quickbooks_final_invoice_outbox
WHEN NEW.state = 'succeeded' BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_submit_completion_unbound')
  WHERE OLD.operation = 'submit' AND NOT EXISTS (
    SELECT 1 FROM quickbooks_final_invoice_intents i
     WHERE i.intent_id = OLD.intent_id AND i.tenant_id = OLD.tenant_id
       AND i.state = 'submitted' AND i.provider_invoice_id IS NOT NULL
       AND i.provider_submitted_at IS NOT NULL
       AND i.provider_payload_sha256 = OLD.provider_payload_sha256
  );
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_resolve_completion_unbound')
  WHERE OLD.operation = 'resolve' AND NOT EXISTS (
    SELECT 1 FROM quickbooks_final_invoice_intents i
     WHERE i.intent_id = OLD.intent_id AND i.tenant_id = OLD.tenant_id
       AND i.state = 'matched' AND i.provider_invoice_id IS NOT NULL
       AND i.provider_matched_at IS NOT NULL
  );
END;

CREATE TRIGGER quickbooks_final_invoice_outbox_no_delete
BEFORE DELETE ON quickbooks_final_invoice_outbox BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_outbox_retained');
END;

CREATE TABLE quickbooks_final_invoice_command_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation = 'reconcile'),
  idempotency_key_sha256 TEXT NOT NULL CHECK (
    length(idempotency_key_sha256) = 64
    AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  requested_version INTEGER NOT NULL CHECK (requested_version > 0),
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  UNIQUE (tenant_id, idempotency_key_sha256),
  FOREIGN KEY (intent_id) REFERENCES quickbooks_final_invoice_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_quickbooks_final_invoice_command_receipts_intent
  ON quickbooks_final_invoice_command_receipts (intent_id, created_at);
CREATE TRIGGER quickbooks_final_invoice_command_receipts_append_only_update
BEFORE UPDATE ON quickbooks_final_invoice_command_receipts BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_command_receipts_append_only');
END;
CREATE TRIGGER quickbooks_final_invoice_command_receipts_append_only_delete
BEFORE DELETE ON quickbooks_final_invoice_command_receipts BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_command_receipts_append_only');
END;

CREATE TRIGGER quickbooks_final_invoice_command_receipts_apply
AFTER INSERT ON quickbooks_final_invoice_command_receipts BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_reconcile_actor_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users u
     WHERE u.user_id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id
       AND u.active = 1 AND COALESCE(u.access_role, u.role) IN ('owner', 'accounting')
  );
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_reconcile_version_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM quickbooks_final_invoice_intents i
     WHERE i.intent_id = NEW.intent_id AND i.tenant_id = NEW.tenant_id
       AND i.version = NEW.requested_version
       AND i.state IN ('submitted', 'reconciliation_required')
       AND i.provider_invoice_id IS NOT NULL
  );
  UPDATE quickbooks_final_invoice_intents
     SET version = version + 1, updated_at = NEW.created_at
   WHERE intent_id = NEW.intent_id AND tenant_id = NEW.tenant_id
     AND version = NEW.requested_version;
  INSERT INTO quickbooks_final_invoice_outbox (
    effect_id, tenant_id, intent_id, operation, idempotency_key_sha256,
    request_fingerprint_sha256, state, attempt_count, next_attempt_at, created_at, updated_at
  ) VALUES (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' ||
      lower(hex(randomblob(6))),
    NEW.tenant_id, NEW.intent_id, 'readback', NEW.idempotency_key_sha256,
    NEW.request_fingerprint_sha256, 'pending', 0, NEW.created_at, NEW.created_at, NEW.created_at
  );
END;

CREATE TABLE quickbooks_final_invoice_attempts (
  attempt_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'readback', 'bind', 'resolve')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'finished')),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider_request_id TEXT CHECK (
    provider_request_id IS NULL OR length(provider_request_id) BETWEEN 8 AND 50
  ),
  provider_payload_sha256 TEXT CHECK (
    provider_payload_sha256 IS NULL OR length(provider_payload_sha256) = 64
  ),
  response_class TEXT CHECK (response_class IS NULL OR length(response_class) BETWEEN 1 AND 80),
  response_status INTEGER CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  ),
  intuit_tid TEXT CHECK (intuit_tid IS NULL OR length(intuit_tid) BETWEEN 1 AND 128),
  provider_invoice_id TEXT CHECK (
    provider_invoice_id IS NULL OR (
      length(provider_invoice_id) BETWEEN 1 AND 32
      AND provider_invoice_id NOT GLOB '*[^0-9]*'
    )
  ),
  provider_observation_sha256 TEXT CHECK (
    provider_observation_sha256 IS NULL OR length(provider_observation_sha256) = 64
  ),
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 24 AND 40),
  UNIQUE (effect_id, attempt_number, phase),
  FOREIGN KEY (effect_id) REFERENCES quickbooks_final_invoice_outbox(effect_id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES quickbooks_final_invoice_intents(intent_id) ON DELETE RESTRICT
);

CREATE INDEX idx_quickbooks_final_invoice_attempts_intent
  ON quickbooks_final_invoice_attempts (intent_id, attempt_seq);
CREATE TRIGGER quickbooks_final_invoice_attempts_append_only_update
BEFORE UPDATE ON quickbooks_final_invoice_attempts BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_attempts_append_only');
END;
CREATE TRIGGER quickbooks_final_invoice_attempts_append_only_delete
BEFORE DELETE ON quickbooks_final_invoice_attempts BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_attempts_append_only');
END;

CREATE TRIGGER quickbooks_final_invoice_outbox_started_attempt
AFTER UPDATE OF state ON quickbooks_final_invoice_outbox
WHEN OLD.state != 'attempting' AND NEW.state = 'attempting' BEGIN
  INSERT INTO quickbooks_final_invoice_attempts (
    effect_id, tenant_id, intent_id, operation, attempt_number, phase,
    request_fingerprint_sha256, provider_request_id, provider_payload_sha256, occurred_at
  ) VALUES (
    NEW.effect_id, NEW.tenant_id, NEW.intent_id, NEW.operation, NEW.attempt_count, 'started',
    NEW.request_fingerprint_sha256, NEW.provider_request_id, NEW.provider_payload_sha256,
    NEW.updated_at
  );
END;

CREATE TABLE quickbooks_final_invoice_observations (
  observation_id TEXT PRIMARY KEY CHECK (length(observation_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  provider_invoice_id TEXT CHECK (
    provider_invoice_id IS NULL OR (
      length(provider_invoice_id) BETWEEN 1 AND 32
      AND provider_invoice_id NOT GLOB '*[^0-9]*'
    )
  ),
  normalized_sha256 TEXT CHECK (
    normalized_sha256 IS NULL OR (
      length(normalized_sha256) = 64 AND normalized_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  provider_readback_sha256 TEXT CHECK (
    provider_readback_sha256 IS NULL OR (
      length(provider_readback_sha256) = 64
      AND provider_readback_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  provider_facts_sha256 TEXT CHECK (
    provider_facts_sha256 IS NULL OR (
      length(provider_facts_sha256) = 64
      AND provider_facts_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  facts_json TEXT CHECK (facts_json IS NULL OR length(facts_json) BETWEEN 2 AND 32768),
  outcome_code TEXT NOT NULL CHECK (outcome_code IN (
    'exact_match', 'drift', 'missing', 'ambiguous', 'invalid_response'
  )),
  balance_due TEXT CHECK (
    balance_due IS NULL OR (
      length(balance_due) BETWEEN 4 AND 12
      AND balance_due GLOB '*.[0-9][0-9]'
    )
  ),
  payment_status TEXT CHECK (payment_status IS NULL OR payment_status IN (
    'Not Due', 'Due', 'Partially Paid', 'Paid', 'Overdue', 'Voided', 'Unverified'
  )),
  intuit_tid TEXT CHECK (intuit_tid IS NULL OR length(intuit_tid) BETWEEN 1 AND 128),
  checked_at TEXT NOT NULL CHECK (length(checked_at) BETWEEN 24 AND 40),
  FOREIGN KEY (intent_id) REFERENCES quickbooks_final_invoice_intents(intent_id) ON DELETE RESTRICT,
  CHECK (
    (provider_readback_sha256 IS NULL AND provider_facts_sha256 IS NULL AND facts_json IS NULL)
    OR (provider_readback_sha256 IS NOT NULL AND provider_facts_sha256 IS NOT NULL
      AND facts_json IS NOT NULL)
  )
);

CREATE INDEX idx_quickbooks_final_invoice_observations_intent
  ON quickbooks_final_invoice_observations (intent_id, checked_at);
CREATE TRIGGER quickbooks_final_invoice_observations_append_only_update
BEFORE UPDATE ON quickbooks_final_invoice_observations BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_observations_append_only');
END;
CREATE TRIGGER quickbooks_final_invoice_observations_append_only_delete
BEFORE DELETE ON quickbooks_final_invoice_observations BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_observations_append_only');
END;

-- A Frappe candidate can be withheld before an immutable intent exists (for example, a missing
-- CustomerRef). Retain that explicit no-call hold without storing Frappe's free-text message.
CREATE TABLE quickbooks_final_invoice_candidate_holds (
  hold_id TEXT PRIMARY KEY CHECK (length(hold_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 1 AND 160),
  blocker_code TEXT NOT NULL CHECK (length(blocker_code) BETWEEN 1 AND 80),
  citations_json TEXT NOT NULL CHECK (length(citations_json) BETWEEN 2 AND 32768),
  observation_sha256 TEXT NOT NULL CHECK (
    length(observation_sha256) = 64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 24 AND 40),
  UNIQUE (tenant_id, roof_job_id, blocker_code, observation_sha256)
);

CREATE INDEX idx_quickbooks_final_invoice_candidate_holds_job
  ON quickbooks_final_invoice_candidate_holds (tenant_id, roof_job_id, observed_at);
CREATE TRIGGER quickbooks_final_invoice_candidate_holds_append_only_update
BEFORE UPDATE ON quickbooks_final_invoice_candidate_holds BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_candidate_holds_append_only');
END;
CREATE TRIGGER quickbooks_final_invoice_candidate_holds_append_only_delete
BEFORE DELETE ON quickbooks_final_invoice_candidate_holds BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_candidate_holds_append_only');
END;

-- Mutable current truth is separated from the append-only observations above. A hold is resolved
-- only by a later successful discovery that explicitly sees the same job without that blocker.
CREATE TABLE quickbooks_final_invoice_current_holds (
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 1 AND 160),
  blocker_code TEXT NOT NULL CHECK (length(blocker_code) BETWEEN 1 AND 80),
  citations_json TEXT NOT NULL CHECK (length(citations_json) BETWEEN 2 AND 32768),
  observation_sha256 TEXT NOT NULL CHECK (
    length(observation_sha256) = 64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  first_observed_at TEXT NOT NULL CHECK (length(first_observed_at) BETWEEN 24 AND 40),
  last_observed_at TEXT NOT NULL CHECK (length(last_observed_at) BETWEEN 24 AND 40),
  resolved_at TEXT CHECK (resolved_at IS NULL OR length(resolved_at) BETWEEN 24 AND 40),
  PRIMARY KEY (tenant_id, roof_job_id, blocker_code)
);

CREATE INDEX idx_quickbooks_final_invoice_current_holds_open
  ON quickbooks_final_invoice_current_holds (tenant_id, resolved_at, last_observed_at);

CREATE TRIGGER quickbooks_final_invoice_current_holds_guard
BEFORE UPDATE ON quickbooks_final_invoice_current_holds BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_current_hold_identity_immutable')
  WHERE NEW.tenant_id != OLD.tenant_id
     OR NEW.roof_job_id != OLD.roof_job_id
     OR NEW.blocker_code != OLD.blocker_code
     OR NEW.first_observed_at != OLD.first_observed_at;
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_current_hold_time_invalid')
  WHERE NEW.last_observed_at < OLD.last_observed_at
     OR (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS NULL
       AND NEW.last_observed_at <= OLD.last_observed_at)
     OR (NEW.resolved_at IS NOT NULL AND NEW.resolved_at < NEW.last_observed_at);
END;

CREATE TRIGGER quickbooks_final_invoice_current_holds_no_delete
BEFORE DELETE ON quickbooks_final_invoice_current_holds BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_current_holds_retained');
END;

CREATE TRIGGER quickbooks_final_invoice_intents_insert_event
AFTER INSERT ON quickbooks_final_invoice_intents BEGIN
  INSERT INTO quickbooks_final_invoice_events (
    tenant_id, intent_id, intent_version, event_type, state_from, state_to,
    actor_kind, actor_user_id, candidate_fingerprint_sha256, detail_code, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.intent_id, NEW.version, 'discovered', NULL, NEW.state,
    'system', NULL, NEW.candidate_fingerprint_sha256, NEW.blocker_code, NEW.created_at
  );
END;

CREATE TRIGGER quickbooks_final_invoice_intents_transition_guard
BEFORE UPDATE OF state ON quickbooks_final_invoice_intents BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_transition_invalid')
  WHERE NOT (
    (OLD.state = 'connection_required' AND NEW.state IN ('connection_required', 'blocked', 'pending_review'))
    OR (OLD.state = 'blocked' AND NEW.state IN ('blocked', 'connection_required', 'pending_review'))
    OR (OLD.state = 'pending_review' AND NEW.state IN ('pending_review', 'blocked', 'connection_required', 'rejected', 'submission_pending'))
    OR (OLD.state = 'submission_pending' AND NEW.state IN ('submission_pending', 'submitted', 'blocked', 'failed', 'reconciliation_required'))
    OR (OLD.state = 'submitted' AND NEW.state IN ('submitted', 'matched', 'reconciliation_required'))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN ('reconciliation_required', 'submitted', 'matched', 'failed'))
    OR (OLD.state = 'failed' AND NEW.state IN ('failed', 'pending_review', 'reconciliation_required'))
    OR (OLD.state = 'rejected' AND NEW.state = 'rejected')
    OR (OLD.state = 'matched' AND NEW.state IN ('matched', 'reconciliation_required'))
  );
END;

CREATE TRIGGER quickbooks_final_invoice_intents_version_guard
BEFORE UPDATE ON quickbooks_final_invoice_intents BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_version_invalid')
  WHERE NEW.version != OLD.version + 1;
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_basis_immutable')
  WHERE NEW.tenant_id != OLD.tenant_id
     OR NEW.intent_id != OLD.intent_id
     OR NEW.roof_job_id != OLD.roof_job_id
     OR NEW.shop_order_id IS NOT OLD.shop_order_id
     OR NEW.completion_packet_id != OLD.completion_packet_id
     OR NEW.completion_version != OLD.completion_version
     OR NEW.completion_sha256 != OLD.completion_sha256
     OR NEW.customer_quote_id != OLD.customer_quote_id
     OR NEW.quote_version != OLD.quote_version
     OR NEW.quote_sha256 != OLD.quote_sha256
     OR NEW.changes_sha256 != OLD.changes_sha256
     OR NEW.basis_sha256 != OLD.basis_sha256
     OR NEW.candidate_fingerprint_sha256 != OLD.candidate_fingerprint_sha256
     OR NEW.realm_id != OLD.realm_id
     OR NEW.customer_ref != OLD.customer_ref
     OR NEW.item_ref != OLD.item_ref
     OR NEW.tax_code_ref != OLD.tax_code_ref
     OR NEW.terms_ref != OLD.terms_ref
     OR NEW.currency != OLD.currency
     OR NEW.subtotal != OLD.subtotal
     OR NEW.tax_amount != OLD.tax_amount
     OR NEW.total_amount != OLD.total_amount
     OR NEW.already_invoiced != OLD.already_invoiced
     OR NEW.final_balance != OLD.final_balance
     OR NEW.tax_code != OLD.tax_code
     OR NEW.tax_rate != OLD.tax_rate
     OR NEW.invoice_date != OLD.invoice_date
     OR NEW.due_date != OLD.due_date
     OR NEW.lines_json != OLD.lines_json
     OR NEW.evidence_json != OLD.evidence_json
     OR NEW.provider_payload_json != OLD.provider_payload_json
     OR NEW.provider_payload_sha256 != OLD.provider_payload_sha256
     OR NEW.provider_request_id != OLD.provider_request_id;
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_provider_evidence_invalid')
  WHERE (OLD.provider_invoice_id IS NOT NULL
       AND NEW.provider_invoice_id IS NOT OLD.provider_invoice_id)
     OR (OLD.provider_invoice_sha256 IS NOT NULL
       AND NEW.provider_invoice_sha256 IS NOT OLD.provider_invoice_sha256)
     OR (OLD.provider_submitted_at IS NOT NULL
       AND NEW.provider_submitted_at IS NOT OLD.provider_submitted_at)
     OR (OLD.provider_matched_at IS NOT NULL
       AND NEW.provider_matched_at IS NOT OLD.provider_matched_at);
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_decision_evidence_immutable')
  WHERE (OLD.approval_idempotency_sha256 IS NOT NULL AND (
          NEW.approval_idempotency_sha256 IS NOT OLD.approval_idempotency_sha256
          OR NEW.approval_fingerprint_sha256 IS NOT OLD.approval_fingerprint_sha256
          OR NEW.approved_by_user_id IS NOT OLD.approved_by_user_id
          OR NEW.approved_at IS NOT OLD.approved_at))
     OR (OLD.rejection_idempotency_sha256 IS NOT NULL AND (
          NEW.rejection_idempotency_sha256 IS NOT OLD.rejection_idempotency_sha256
          OR NEW.rejection_fingerprint_sha256 IS NOT OLD.rejection_fingerprint_sha256
          OR NEW.rejected_by_user_id IS NOT OLD.rejected_by_user_id
          OR NEW.rejected_at IS NOT OLD.rejected_at
          OR NEW.reason_code IS NOT OLD.reason_code))
     OR NEW.reconcile_idempotency_sha256 IS NOT OLD.reconcile_idempotency_sha256
     OR NEW.reconcile_fingerprint_sha256 IS NOT OLD.reconcile_fingerprint_sha256;
END;

CREATE TRIGGER quickbooks_final_invoice_intents_update_event
AFTER UPDATE ON quickbooks_final_invoice_intents BEGIN
  INSERT INTO quickbooks_final_invoice_events (
    tenant_id, intent_id, intent_version, event_type, state_from, state_to,
    actor_kind, actor_user_id, candidate_fingerprint_sha256, detail_code, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.intent_id, NEW.version,
    CASE
      WHEN OLD.state = 'pending_review' AND NEW.state = 'submission_pending' THEN 'approved'
      WHEN OLD.state = 'pending_review' AND NEW.state = 'rejected' THEN 'rejected'
      WHEN OLD.state = NEW.state AND EXISTS (
        SELECT 1 FROM quickbooks_final_invoice_command_receipts r
         WHERE r.intent_id = NEW.intent_id AND r.tenant_id = NEW.tenant_id
           AND r.requested_version = OLD.version AND r.created_at = NEW.updated_at
      ) THEN 'reconcile_requested'
      ELSE NEW.state
    END,
    OLD.state, NEW.state,
    CASE
      WHEN OLD.state = 'pending_review' AND NEW.state = 'submission_pending' THEN
        (SELECT COALESCE(access_role, role) FROM app_users
          WHERE user_id = NEW.approved_by_user_id AND tenant_id = NEW.tenant_id)
      WHEN OLD.state = 'pending_review' AND NEW.state = 'rejected' THEN
        (SELECT COALESCE(access_role, role) FROM app_users
          WHERE user_id = NEW.rejected_by_user_id AND tenant_id = NEW.tenant_id)
      WHEN OLD.state = NEW.state THEN COALESCE((
        SELECT COALESCE(u.access_role, u.role)
          FROM quickbooks_final_invoice_command_receipts r
          JOIN app_users u ON u.user_id = r.actor_user_id AND u.tenant_id = r.tenant_id
         WHERE r.intent_id = NEW.intent_id AND r.tenant_id = NEW.tenant_id
           AND r.requested_version = OLD.version AND r.created_at = NEW.updated_at
         LIMIT 1
      ), 'system')
      ELSE 'system'
    END,
    CASE
      WHEN OLD.state = 'pending_review' AND NEW.state = 'submission_pending' THEN NEW.approved_by_user_id
      WHEN OLD.state = 'pending_review' AND NEW.state = 'rejected' THEN NEW.rejected_by_user_id
      WHEN OLD.state = NEW.state THEN (
        SELECT r.actor_user_id FROM quickbooks_final_invoice_command_receipts r
         WHERE r.intent_id = NEW.intent_id AND r.tenant_id = NEW.tenant_id
           AND r.requested_version = OLD.version AND r.created_at = NEW.updated_at
         LIMIT 1
      )
      ELSE NULL
    END,
    NEW.candidate_fingerprint_sha256,
    COALESCE(NEW.error_code, NEW.blocker_code, NEW.reason_code), NEW.updated_at
  );
END;

CREATE TRIGGER quickbooks_final_invoice_intents_approval_outbox
AFTER UPDATE OF state ON quickbooks_final_invoice_intents
WHEN OLD.state = 'pending_review' AND NEW.state = 'submission_pending' BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_approval_required')
  WHERE NEW.approved_by_user_id IS NULL
     OR NEW.approved_at IS NULL
     OR NEW.approval_idempotency_sha256 IS NULL
     OR NEW.approval_fingerprint_sha256 IS NULL;
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_approval_role_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users
     WHERE user_id = NEW.approved_by_user_id
       AND tenant_id = NEW.tenant_id
       AND active = 1
       AND COALESCE(access_role, role) IN ('owner', 'accounting')
  );
  INSERT INTO quickbooks_final_invoice_outbox (
    effect_id, tenant_id, intent_id, operation, idempotency_key_sha256,
    request_fingerprint_sha256, provider_request_id, provider_payload_sha256,
    state, attempt_count, next_attempt_at, created_at, updated_at
  ) VALUES (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' ||
      lower(hex(randomblob(6))),
    NEW.tenant_id, NEW.intent_id, 'submit', NEW.approval_idempotency_sha256,
    NEW.approval_fingerprint_sha256, NEW.provider_request_id, NEW.provider_payload_sha256,
    'pending', 0, NEW.updated_at, NEW.updated_at, NEW.updated_at
  );
END;

CREATE TRIGGER quickbooks_final_invoice_intents_rejection_guard
BEFORE UPDATE OF state ON quickbooks_final_invoice_intents
WHEN OLD.state = 'pending_review' AND NEW.state = 'rejected' BEGIN
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_rejection_required')
  WHERE NEW.rejected_by_user_id IS NULL
     OR NEW.rejected_at IS NULL
     OR NEW.rejection_idempotency_sha256 IS NULL
     OR NEW.rejection_fingerprint_sha256 IS NULL
     OR NEW.reason_code IS NULL;
  SELECT RAISE(ABORT, 'quickbooks_final_invoice_rejection_role_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users
     WHERE user_id = NEW.rejected_by_user_id
       AND tenant_id = NEW.tenant_id
       AND active = 1
       AND COALESCE(access_role, role) IN ('owner', 'accounting')
  );
END;
