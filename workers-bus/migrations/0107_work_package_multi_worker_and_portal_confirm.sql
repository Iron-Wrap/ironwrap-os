-- 0107_work_package_multi_worker_and_portal_confirm.sql
-- IRO-42: durable per-worker acknowledgement snapshot and one original
-- evidence instance per assigned worker + slot. IRO-51: portal decision
-- confirmation ledger plus a local-dev outbox kind. Portal option packages
-- may now carry office-authored comparison fields without a Frappe write.

CREATE TABLE IF NOT EXISTS work_package_worker_acknowledgements (
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  work_package_id TEXT NOT NULL CHECK (
    length(work_package_id) BETWEEN 1 AND 140
    AND work_package_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  work_package_version INTEGER NOT NULL CHECK (work_package_version BETWEEN 1 AND 1000000),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) BETWEEN 1 AND 140),
  actor_role TEXT NOT NULL CHECK (length(trim(actor_role)) BETWEEN 1 AND 140),
  event_id TEXT NOT NULL CHECK (
    length(event_id) BETWEEN 8 AND 140
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  device_action_id TEXT CHECK (
    device_action_id IS NULL OR length(trim(device_action_id)) BETWEEN 8 AND 80
  ),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  PRIMARY KEY (tenant_id, work_package_id, work_package_version, actor_user_id),
  FOREIGN KEY (work_package_id, tenant_id, work_package_version)
    REFERENCES work_packages(work_package_id, tenant_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_work_package_worker_acks_package
  ON work_package_worker_acknowledgements (
    tenant_id, work_package_id, work_package_version, occurred_at
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_package_worker_acks_event
  ON work_package_worker_acknowledgements (tenant_id, event_id);

INSERT INTO work_package_worker_acknowledgements (
  tenant_id, work_package_id, work_package_version, actor_user_id, actor_role,
  event_id, device_action_id, occurred_at, created_at
)
SELECT
  tenant_id, work_package_id, work_package_version, actor_user_id, actor_role,
  event_id, device_action_id, occurred_at, created_at
FROM work_package_events
WHERE event_kind = 'acknowledged';

CREATE TRIGGER work_package_worker_acks_project
AFTER INSERT ON work_package_events
WHEN NEW.event_kind = 'acknowledged'
BEGIN
  INSERT INTO work_package_worker_acknowledgements (
    tenant_id, work_package_id, work_package_version, actor_user_id, actor_role,
    event_id, device_action_id, occurred_at, created_at
  ) VALUES (
    NEW.tenant_id, NEW.work_package_id, NEW.work_package_version, NEW.actor_user_id,
    NEW.actor_role, NEW.event_id, NEW.device_action_id, NEW.occurred_at, NEW.created_at
  );
END;

CREATE TRIGGER work_package_worker_acks_append_only_update
BEFORE UPDATE ON work_package_worker_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'work_package_worker_ack_append_only');
END;

CREATE TRIGGER work_package_worker_acks_append_only_delete
BEFORE DELETE ON work_package_worker_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'work_package_worker_ack_append_only');
END;

-- One original (non-correction) capture per worker and declared slot. A fix
-- is a new row with evidence_correction_of set, so the same worker can replace
-- their own instance without colliding here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_field_actions_wp_actor_slot_original
  ON field_actions (
    tenant_id, work_package_id, work_package_version, evidence_slot_id, user_id
  )
  WHERE work_package_id IS NOT NULL AND evidence_correction_of IS NULL;

ALTER TABLE operating_option_packages ADD COLUMN options_json TEXT
  CHECK (
    options_json IS NULL OR (
      json_valid(options_json)
      AND length(options_json) BETWEEN 2 AND 20000
    )
  );

ALTER TABLE operating_option_packages ADD COLUMN price_delta_cents INTEGER
  CHECK (
    price_delta_cents IS NULL
    OR price_delta_cents BETWEEN -100000000 AND 100000000
  );

ALTER TABLE operating_option_packages ADD COLUMN currency TEXT
  CHECK (currency IS NULL OR length(trim(currency)) BETWEEN 3 AND 8);

ALTER TABLE operating_option_packages ADD COLUMN warranty_summary TEXT
  CHECK (
    warranty_summary IS NULL
    OR length(trim(warranty_summary)) BETWEEN 1 AND 2000
  );

CREATE TABLE IF NOT EXISTS portal_decision_confirmations (
  confirmation_id TEXT PRIMARY KEY CHECK (
    length(confirmation_id) BETWEEN 12 AND 140
    AND confirmation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  decision_id TEXT NOT NULL CHECK (
    length(decision_id) BETWEEN 12 AND 160
    AND decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  portal_link_id TEXT NOT NULL CHECK (length(trim(portal_link_id)) BETWEEN 8 AND 140),
  roof_job_id TEXT NOT NULL CHECK (length(trim(roof_job_id)) BETWEEN 3 AND 140),
  customer_id TEXT NOT NULL CHECK (length(trim(customer_id)) BETWEEN 8 AND 200),
  recipient TEXT NOT NULL CHECK (length(trim(recipient)) BETWEEN 3 AND 320),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'dev_outbox', 'none')),
  option_package_id TEXT NOT NULL CHECK (length(trim(option_package_id)) BETWEEN 3 AND 140),
  option_label TEXT NOT NULL CHECK (length(trim(option_label)) BETWEEN 1 AND 200),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('provider_accepted', 'dev_captured')
  ),
  provider_message_id TEXT CHECK (
    provider_message_id IS NULL OR length(trim(provider_message_id)) BETWEEN 1 AND 200
  ),
  error_code TEXT CHECK (error_code IS NULL),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  CHECK (
    (outcome = 'provider_accepted' AND channel = 'email' AND provider_message_id IS NOT NULL)
    OR (outcome = 'dev_captured' AND channel = 'dev_outbox' AND provider_message_id IS NULL)
  )
);

CREATE TRIGGER IF NOT EXISTS portal_decision_confirmations_scope_guard
BEFORE INSERT ON portal_decision_confirmations
WHEN NOT EXISTS (
  SELECT 1 FROM customer_portal_decision_intents decision
   WHERE decision.decision_id = NEW.decision_id
     AND decision.state = 'recorded'
     AND decision.tenant_id = NEW.tenant_id
     AND decision.portal_link_id = NEW.portal_link_id
     AND decision.roof_job_id = NEW.roof_job_id
     AND decision.customer_id = NEW.customer_id
     AND decision.option_package_id = NEW.option_package_id
     AND decision.option_label = NEW.option_label
)
BEGIN
  SELECT RAISE(ABORT, 'portal_decision_confirmation_scope_mismatch');
END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_decision_confirmations_decision
  ON portal_decision_confirmations (tenant_id, decision_id);

CREATE INDEX IF NOT EXISTS idx_portal_decision_confirmations_job
  ON portal_decision_confirmations (tenant_id, roof_job_id, created_at DESC);

CREATE TRIGGER portal_decision_confirmations_append_only_update
BEFORE UPDATE ON portal_decision_confirmations
BEGIN
  SELECT RAISE(ABORT, 'portal_decision_confirmation_append_only');
END;

CREATE TRIGGER portal_decision_confirmations_append_only_delete
BEFORE DELETE ON portal_decision_confirmations
BEGIN
  SELECT RAISE(ABORT, 'portal_decision_confirmation_append_only');
END;

-- Widen local-dev capture kinds the same way 0066 did for contract acceptance.
CREATE TABLE IF NOT EXISTS dev_outbox_0107 (
  capture_id TEXT PRIMARY KEY CHECK (
    length(capture_id) BETWEEN 12 AND 80
    AND capture_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('magic_link', 'contract_acceptance', 'portal_decision_confirmation', 'user_invite')),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  href TEXT NOT NULL CHECK (length(href) BETWEEN 16 AND 2048),
  created_at TEXT NOT NULL
);

INSERT INTO dev_outbox_0107 (capture_id, kind, recipient, href, created_at)
SELECT capture_id, kind, recipient, href, created_at FROM dev_outbox;

DROP TABLE dev_outbox;

ALTER TABLE dev_outbox_0107 RENAME TO dev_outbox;

CREATE INDEX IF NOT EXISTS idx_dev_outbox_created ON dev_outbox (created_at DESC);
