-- 0119_commercial_deposit_approval_separation.sql
--
-- A commercial deposit remains agent-derived even when an authenticated staff member had to
-- recover its acceptance-to-accounting handoff.  That means accounting_intents.derived_by_user_id
-- cannot name the human who caused the recovery.  Capture that causal request as a separate,
-- immutable approval exclusion and backstop the accounting command ledger with it.

CREATE TABLE commercial_deposit_approval_exclusions (
  request_id TEXT PRIMARY KEY CHECK (
    length(request_id) BETWEEN 32 AND 180
    AND request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL,
  derivation_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  derivation_version INTEGER NOT NULL CHECK (derivation_version BETWEEN 2 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, intent_id, actor_user_id),
  FOREIGN KEY (request_id, tenant_id)
    REFERENCES commercial_deposit_derivation_requests(request_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (derivation_id, tenant_id)
    REFERENCES commercial_deposit_derivations(derivation_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

-- Even a direct insert must describe a real request that finished the agent-derived commercial
-- deposit transition at the version being bound.
CREATE TRIGGER commercial_deposit_approval_exclusions_insert_guard
BEFORE INSERT ON commercial_deposit_approval_exclusions BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_approval_exclusion_binding_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM commercial_deposit_derivation_requests AS request
      JOIN commercial_deposit_derivations AS derivation
        ON derivation.derivation_id = request.derivation_id
       AND derivation.tenant_id = request.tenant_id
      JOIN accounting_intents AS intent
        ON intent.intent_id = derivation.intent_id
       AND intent.tenant_id = derivation.tenant_id
     WHERE request.request_id = NEW.request_id
       AND request.tenant_id = NEW.tenant_id
       AND request.actor_user_id = NEW.actor_user_id
       AND request.state = 'derived'
       AND request.derivation_version = NEW.derivation_version
       AND derivation.derivation_id = NEW.derivation_id
       AND derivation.state = 'derived'
       AND derivation.version = NEW.derivation_version
       AND derivation.intent_id = NEW.intent_id
       AND intent.kind = 'deposit_invoice'
       AND intent.derived_by_actor_kind = 'agent'
       AND intent.derived_by_user_id IS NULL
  );
END;

CREATE TRIGGER commercial_deposit_approval_exclusions_append_only_update
BEFORE UPDATE ON commercial_deposit_approval_exclusions BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_approval_exclusions_append_only');
END;

CREATE TRIGGER commercial_deposit_approval_exclusions_append_only_delete
BEFORE DELETE ON commercial_deposit_approval_exclusions BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_approval_exclusions_append_only');
END;

-- The request was opened against OLD.derivation_version.  A successful finish at a higher
-- version is the durable evidence that this authenticated recovery request participated in the
-- transition that created the provider-facing candidate.  A request made after the derivation
-- already existed has equal versions and creates no exclusion.
CREATE TRIGGER commercial_deposit_derivation_requests_capture_approval_exclusion
AFTER UPDATE ON commercial_deposit_derivation_requests
WHEN OLD.state = 'pending'
 AND NEW.state = 'derived'
 AND NEW.derivation_version > OLD.derivation_version
BEGIN
  INSERT OR IGNORE INTO commercial_deposit_approval_exclusions (
    request_id, tenant_id, derivation_id, intent_id, actor_user_id,
    derivation_version, created_at
  )
  SELECT NEW.request_id, NEW.tenant_id, NEW.derivation_id, derivation.intent_id,
         NEW.actor_user_id, NEW.derivation_version, NEW.updated_at
    FROM commercial_deposit_derivations AS derivation
    JOIN accounting_intents AS intent
      ON intent.intent_id = derivation.intent_id
     AND intent.tenant_id = derivation.tenant_id
   WHERE derivation.derivation_id = NEW.derivation_id
     AND derivation.tenant_id = NEW.tenant_id
     AND derivation.state = 'derived'
     AND derivation.version = NEW.derivation_version
     AND intent.kind = 'deposit_invoice'
     AND intent.derived_by_actor_kind = 'agent'
     AND intent.derived_by_user_id IS NULL;
END;

-- Forward-fill requests whose causal transition was committed before this migration.  The event
-- must fall inside the request lifetime, so a later recovery/readback of an already-derived row
-- does not retroactively disqualify that reader from approval.
INSERT INTO commercial_deposit_approval_exclusions (
  request_id, tenant_id, derivation_id, intent_id, actor_user_id,
  derivation_version, created_at
)
SELECT request.request_id, request.tenant_id, request.derivation_id, derivation.intent_id,
       request.actor_user_id, request.derivation_version, request.updated_at
  FROM commercial_deposit_derivation_requests AS request
  JOIN commercial_deposit_derivations AS derivation
    ON derivation.derivation_id = request.derivation_id
   AND derivation.tenant_id = request.tenant_id
  JOIN commercial_deposit_derivation_events AS event
    ON event.derivation_id = request.derivation_id
   AND event.tenant_id = request.tenant_id
   AND event.event_version = request.derivation_version
   AND event.intent_id = derivation.intent_id
  JOIN accounting_intents AS intent
    ON intent.intent_id = derivation.intent_id
   AND intent.tenant_id = derivation.tenant_id
 WHERE request.state = 'derived'
   AND derivation.state = 'derived'
   AND derivation.version = request.derivation_version
   AND event.state = 'derived'
   AND event.occurred_at >= request.created_at
   AND event.occurred_at <= request.updated_at
   AND intent.kind = 'deposit_invoice'
   AND intent.derived_by_actor_kind = 'agent'
   AND intent.derived_by_user_id IS NULL
ON CONFLICT DO NOTHING;

-- This is deliberately a separate BEFORE trigger.  The original 0058 derived_by_user_id guard
-- remains intact and continues to protect every human-derived accounting intent.
CREATE TRIGGER accounting_intent_command_receipts_commercial_deposit_sod
BEFORE INSERT ON accounting_intent_command_receipts
WHEN NEW.operation = 'approve'
BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_separation_of_duty')
  WHERE EXISTS (
    SELECT 1 FROM commercial_deposit_approval_exclusions AS exclusion
     WHERE exclusion.tenant_id = NEW.tenant_id
       AND exclusion.intent_id = NEW.intent_id
       AND exclusion.actor_user_id = NEW.actor_user_id
  );
END;
