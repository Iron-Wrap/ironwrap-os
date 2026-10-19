-- 0156_proposal_delivery_confirmations.sql - a person records what they found when a proposal
-- send could not be confirmed delivered.
--
-- A proposal is not sent again until its last send is confirmed delivered. A send whose provider
-- readback conflicted ends in the effect runtime's terminal `manual_exception`, which nothing could
-- leave, so the proposal stayed blocked for good. A person (owner, operations or sales: the
-- commercial set) now records "delivered" or "not delivered" with a short note. That one
-- append-only row is the receipt; it moves the effect to `succeeded` or `reconciled` (not executed),
-- resolves the effect's open exception, and writes one audit_log row, all in the insert's own
-- statement. Agents never write here: the route takes a person's own session.
--
-- `external_effect_binding_guard` (0042) is re-created under its name with exactly one change: a
-- `manual_exception` effect may move to `succeeded` or `reconciled` only when a matching
-- confirmation exists. Every other rule is copied unchanged.

CREATE TABLE IF NOT EXISTS proposal_delivery_confirmations (
  confirmation_id TEXT PRIMARY KEY CHECK (length(confirmation_id) BETWEEN 16 AND 200),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 128),
  effect_id TEXT NOT NULL,
  proposal_pack_id TEXT NOT NULL CHECK (length(proposal_pack_id) BETWEEN 1 AND 160),
  proposal_revision_id TEXT NOT NULL CHECK (length(proposal_revision_id) BETWEEN 1 AND 160),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'not_delivered')),
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 8 AND 500),
  confirmed_by_user_id TEXT NOT NULL CHECK (length(confirmed_by_user_id) BETWEEN 3 AND 128),
  confirmed_by_role TEXT NOT NULL CHECK (confirmed_by_role IN ('owner', 'ops', 'sales')),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, effect_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_proposal_delivery_confirmations_pack
  ON proposal_delivery_confirmations (tenant_id, proposal_pack_id, created_at);

CREATE TRIGGER IF NOT EXISTS proposal_delivery_confirmations_validate_insert
BEFORE INSERT ON proposal_delivery_confirmations BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_confirmation_exists')
    WHERE EXISTS (
      SELECT 1 FROM proposal_delivery_confirmations prior
       WHERE prior.tenant_id = NEW.tenant_id
         AND (prior.effect_id = NEW.effect_id
              OR prior.idempotency_key_hash = NEW.idempotency_key_hash)
    );
  SELECT RAISE(ABORT, 'proposal_delivery_confirmation_effect_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.state = 'manual_exception'
         AND effect.action = 'proposal.publish'
         AND effect.aggregate_type = 'proposal_publication'
         AND effect.aggregate_id = NEW.proposal_pack_id
         AND effect.intent_id = NEW.proposal_revision_id
    );
  SELECT RAISE(ABORT, 'proposal_delivery_confirmation_actor_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM app_users person
       WHERE person.tenant_id = NEW.tenant_id
         AND person.user_id = NEW.confirmed_by_user_id
         AND person.active = 1
         AND person.access_role = NEW.confirmed_by_role
    );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_confirmations_apply
AFTER INSERT ON proposal_delivery_confirmations BEGIN
  UPDATE external_effects
     SET state = CASE NEW.outcome WHEN 'delivered' THEN 'succeeded' ELSE 'reconciled' END,
         lease_expires_at = NULL,
         result_code = CASE NEW.outcome
           WHEN 'delivered' THEN 'delivery_confirmed_by_hand'
           ELSE 'reconciled_not_executed'
         END,
         updated_at = NEW.created_at
   WHERE effect_id = NEW.effect_id AND tenant_id = NEW.tenant_id AND state = 'manual_exception';
  SELECT RAISE(ABORT, 'proposal_delivery_confirmation_apply_failed')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.effect_id
         AND effect.state = CASE NEW.outcome WHEN 'delivered' THEN 'succeeded' ELSE 'reconciled' END
    );
  UPDATE external_effect_exceptions
     SET status = 'resolved',
         resolution_ref = 'proposal-delivery-confirmation:' || NEW.confirmation_id,
         resolved_at = NEW.created_at
   WHERE effect_id = NEW.effect_id AND status = 'open'
     AND NOT EXISTS (
       SELECT 1 FROM external_effect_exceptions resolved
        WHERE resolved.effect_id = external_effect_exceptions.effect_id
          AND resolved.reason_code = external_effect_exceptions.reason_code
          AND resolved.status = 'resolved'
     );
  INSERT INTO audit_log
    (ts, automation, trigger, envelope_id, source_ids, target_ids, action, result, approved_by)
  VALUES (
    NEW.created_at, 'proposal_delivery', 'office', NULL,
    'confirmation:' || NEW.confirmation_id,
    'effect:' || NEW.effect_id || ',proposal:' || NEW.proposal_revision_id,
    'proposal_delivery_' || NEW.outcome, 'ok', NEW.confirmed_by_user_id
  );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_confirmations_append_only_update
BEFORE UPDATE ON proposal_delivery_confirmations BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_confirmations_append_only');
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_confirmations_append_only_delete
BEFORE DELETE ON proposal_delivery_confirmations BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_confirmations_append_only');
END;

DROP TRIGGER IF EXISTS external_effect_binding_guard;
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
    WHERE OLD.state IN ('compensated', 'manual_exception') AND NEW.state != OLD.state
      AND NOT (
        OLD.state = 'manual_exception'
        AND NEW.state IN ('succeeded', 'reconciled')
        AND EXISTS (
          SELECT 1 FROM proposal_delivery_confirmations confirmation
           WHERE confirmation.effect_id = OLD.effect_id
             AND confirmation.outcome =
               CASE NEW.state WHEN 'succeeded' THEN 'delivered' ELSE 'not_delivered' END
        )
      );
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
      (OLD.state = 'compensating' AND NEW.state = 'compensated') OR
      (OLD.state = 'manual_exception' AND NEW.state IN ('succeeded', 'reconciled'))
    );
END;
