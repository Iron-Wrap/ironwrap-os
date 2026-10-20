-- 0161_proposal_delivery_corrections.sql - a person changes what they recorded about a proposal
-- send; the wait for a late provider answer moves into D1 with a window per provider; and every
-- new proposal publication names the person who recorded it.
--
-- Corrections. A person who recorded "delivered" or "not delivered" for a send that could not be
-- confirmed (0156) may change it until the next send of that proposal or the customer's decision
-- on it. A correction is a new append-only row in `proposal_delivery_corrections` that supersedes
-- exactly one earlier answer: the first correction supersedes the 0156 confirmation, each later
-- one the correction before it. An answer can be superseded once, so only the newest answer of a
-- chain can be corrected and a fork is refused; the earlier rows stay as the history. The insert's
-- own statement moves the send between `succeeded` (delivered) and `reconciled` (not delivered)
-- and writes one audit_log row. `external_effect_binding_guard` allows those two moves only when
-- the newest answer in the send's chain is a correction that says so, written at the moment of the
-- move.
--
-- Late answers. "Not delivered" on an `unknown` send waits until the provider's own answer can no
-- longer arrive. 0156 enforced that in the Worker alone, with EFFECT_ATTEMPT_LEASE_MS for every
-- provider. `proposal_delivery_confirmations_validate_insert` now refuses it in D1 too, with the
-- window of the send's provider from `proposal_delivery_late_answer_windows`, or the default row
-- `*`. The Worker reads the same rows, and each row says where its value comes from.
--
-- Recorded by. A new `commercial_proposal_publication_events` row needs a
-- `commercial_proposal_publication_recorders` row, written just before it in the same batch, that
-- names the active person who recorded it. The recorder is a table of its own, not a column: the
-- final-invoice basis hashes whole publication rows (`SELECT *`), so a new column would change the
-- hash of every publication recorded before this migration. Older publications have no recorder.
--
-- Re-created from 0156 under their names: `proposal_delivery_confirmations_validate_insert` and
-- `external_effect_binding_guard`. Every 0156 line is carried over unchanged and in order, and
-- each added line ends with `-- [0161]`.

CREATE TABLE IF NOT EXISTS proposal_delivery_late_answer_windows (
  provider TEXT PRIMARY KEY CHECK (length(provider) BETWEEN 1 AND 120),
  window_ms INTEGER NOT NULL CHECK (window_ms BETWEEN 0 AND 604800000),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 20 AND 1000)
);

-- Only the default is recorded: no proposal send provider is wired in this repository yet (the
-- send runs outside the Worker, through /admin/effects/*). A provider adds its own row, with the
-- source of its value, when it is wired.
INSERT INTO proposal_delivery_late_answer_windows (provider, window_ms, source) VALUES (
  '*', 120000,
  'Default for every provider without its own row: EFFECT_ATTEMPT_LEASE_MS in workers-bus/src/effect-runtime.ts, the lease one send attempt holds. A provider answer that is only late still arrives inside it (0156).'
);

CREATE TRIGGER IF NOT EXISTS proposal_delivery_late_answer_windows_append_only_update
BEFORE UPDATE ON proposal_delivery_late_answer_windows BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_late_answer_windows_append_only');
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_late_answer_windows_append_only_delete
BEFORE DELETE ON proposal_delivery_late_answer_windows BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_late_answer_windows_append_only');
END;

CREATE TABLE IF NOT EXISTS proposal_delivery_corrections (
  correction_id TEXT PRIMARY KEY CHECK (length(correction_id) BETWEEN 16 AND 200),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 128),
  effect_id TEXT NOT NULL,
  proposal_pack_id TEXT NOT NULL CHECK (length(proposal_pack_id) BETWEEN 1 AND 160),
  proposal_revision_id TEXT NOT NULL CHECK (length(proposal_revision_id) BETWEEN 1 AND 160),
  supersedes_confirmation_id TEXT UNIQUE,
  supersedes_correction_id TEXT UNIQUE,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'not_delivered')),
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 8 AND 500),
  corrected_by_user_id TEXT NOT NULL CHECK (length(corrected_by_user_id) BETWEEN 3 AND 128),
  corrected_by_role TEXT NOT NULL CHECK (corrected_by_role IN ('owner', 'ops', 'sales')),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  CHECK ((supersedes_confirmation_id IS NULL) != (supersedes_correction_id IS NULL)),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_confirmation_id)
    REFERENCES proposal_delivery_confirmations(confirmation_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_correction_id)
    REFERENCES proposal_delivery_corrections(correction_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_proposal_delivery_corrections_effect
  ON proposal_delivery_corrections (tenant_id, effect_id, created_at);

CREATE TRIGGER IF NOT EXISTS proposal_delivery_corrections_validate_insert
BEFORE INSERT ON proposal_delivery_corrections BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_correction_exists')
    WHERE EXISTS (
      SELECT 1 FROM proposal_delivery_corrections prior
       WHERE prior.tenant_id = NEW.tenant_id
         AND prior.idempotency_key_hash = NEW.idempotency_key_hash
    );
  -- Only the newest answer of a chain may be superseded: a second correction of the same answer
  -- would fork the history.
  SELECT RAISE(ABORT, 'proposal_delivery_correction_not_latest')
    WHERE EXISTS (
      SELECT 1 FROM proposal_delivery_corrections later
       WHERE later.supersedes_confirmation_id = NEW.supersedes_confirmation_id
          OR later.supersedes_correction_id = NEW.supersedes_correction_id
    );
  -- The superseded answer is about this send.
  SELECT RAISE(ABORT, 'proposal_delivery_correction_chain_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM proposal_delivery_confirmations answer
       WHERE answer.confirmation_id = NEW.supersedes_confirmation_id
         AND answer.tenant_id = NEW.tenant_id
         AND answer.effect_id = NEW.effect_id
         AND answer.proposal_pack_id = NEW.proposal_pack_id
         AND answer.proposal_revision_id = NEW.proposal_revision_id
      UNION ALL
      SELECT 1 FROM proposal_delivery_corrections answer
       WHERE answer.correction_id = NEW.supersedes_correction_id
         AND answer.tenant_id = NEW.tenant_id
         AND answer.effect_id = NEW.effect_id
         AND answer.proposal_pack_id = NEW.proposal_pack_id
         AND answer.proposal_revision_id = NEW.proposal_revision_id
    );
  SELECT RAISE(ABORT, 'proposal_delivery_correction_effect_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.action = 'proposal.publish'
         AND effect.aggregate_type = 'proposal_publication'
         AND effect.aggregate_id = NEW.proposal_pack_id
         AND effect.intent_id = NEW.proposal_revision_id
    );
  -- Open until the next send of this proposal or the customer's decision on it, and only while the
  -- send is where the superseded answer left it (delivered: succeeded; not delivered: reconciled).
  SELECT RAISE(ABORT, 'proposal_delivery_correction_closed')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.effect_id
         AND effect.state = CASE COALESCE(
           (SELECT answer.outcome FROM proposal_delivery_confirmations answer
             WHERE answer.confirmation_id = NEW.supersedes_confirmation_id),
           (SELECT answer.outcome FROM proposal_delivery_corrections answer
             WHERE answer.correction_id = NEW.supersedes_correction_id)
         ) WHEN 'delivered' THEN 'succeeded' ELSE 'reconciled' END
    )
    OR EXISTS (
      SELECT 1 FROM external_effects effect
        JOIN external_effects later
          ON later.tenant_id = effect.tenant_id
         AND later.action = 'proposal.publish'
         AND later.aggregate_type = 'proposal_publication'
         AND later.aggregate_id = effect.aggregate_id
         AND later.effect_id != effect.effect_id
         AND julianday(later.created_at) >= julianday(effect.created_at)
       WHERE effect.effect_id = NEW.effect_id
    )
    OR EXISTS (
      SELECT 1 FROM customer_portal_acceptance_intents acceptance
       WHERE acceptance.tenant_id = NEW.tenant_id
         AND acceptance.proposal_pack_id = NEW.proposal_pack_id
         AND acceptance.state != 'rejected'
    );
  SELECT RAISE(ABORT, 'proposal_delivery_correction_actor_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM app_users person
       WHERE person.tenant_id = NEW.tenant_id
         AND person.user_id = NEW.corrected_by_user_id
         AND person.active = 1
         AND person.access_role = NEW.corrected_by_role
    );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_corrections_apply
AFTER INSERT ON proposal_delivery_corrections BEGIN
  -- A correction that keeps the outcome changes only the record; one that flips it moves the send.
  UPDATE external_effects
     SET state = CASE NEW.outcome WHEN 'delivered' THEN 'succeeded' ELSE 'reconciled' END,
         result_code = CASE NEW.outcome
           WHEN 'delivered' THEN 'delivery_confirmed_by_hand'
           ELSE 'reconciled_not_executed'
         END,
         updated_at = NEW.created_at
   WHERE effect_id = NEW.effect_id AND tenant_id = NEW.tenant_id
     AND state = (CASE NEW.outcome WHEN 'delivered' THEN 'reconciled' ELSE 'succeeded' END);
  SELECT RAISE(ABORT, 'proposal_delivery_correction_apply_failed')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.effect_id
         AND effect.state = CASE NEW.outcome WHEN 'delivered' THEN 'succeeded' ELSE 'reconciled' END
    );
  INSERT INTO audit_log
    (ts, automation, trigger, envelope_id, source_ids, target_ids, action, result, approved_by)
  VALUES (
    NEW.created_at, 'proposal_delivery', 'office', NULL,
    'correction:' || NEW.correction_id || ',supersedes:' ||
      COALESCE(NEW.supersedes_confirmation_id, NEW.supersedes_correction_id),
    'effect:' || NEW.effect_id || ',proposal:' || NEW.proposal_revision_id,
    'proposal_delivery_correction_' || NEW.outcome, 'ok', NEW.corrected_by_user_id
  );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_corrections_append_only_update
BEFORE UPDATE ON proposal_delivery_corrections BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_corrections_append_only');
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_corrections_append_only_delete
BEFORE DELETE ON proposal_delivery_corrections BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_corrections_append_only');
END;

-- `proposal_delivery_confirmations_validate_insert` (0156), re-created with one addition: the
-- late-answer wait.
DROP TRIGGER IF EXISTS proposal_delivery_confirmations_validate_insert;
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
         AND effect.state IN ('manual_exception', 'unknown')
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
  -- [0161] "Not delivered" on an unknown send waits out the late-answer window of its provider
  -- [0161] (that provider's row, else the default `*`), counted from when the send became unknown.
  SELECT RAISE(ABORT, 'proposal_delivery_answer_may_be_late') -- [0161]
    WHERE NEW.outcome = 'not_delivered' AND EXISTS ( -- [0161]
      SELECT 1 FROM external_effects effect -- [0161]
       WHERE effect.effect_id = NEW.effect_id -- [0161]
         AND effect.tenant_id = NEW.tenant_id -- [0161]
         AND effect.state = 'unknown' -- [0161]
         AND julianday(NEW.created_at) < julianday(effect.updated_at) + COALESCE( -- [0161]
           (SELECT late.window_ms FROM proposal_delivery_late_answer_windows late -- [0161]
             WHERE late.provider = effect.provider), -- [0161]
           (SELECT late.window_ms FROM proposal_delivery_late_answer_windows late -- [0161]
             WHERE late.provider = '*') -- [0161]
         ) / 86400000.0 -- [0161]
    ); -- [0161]
END;

-- `external_effect_binding_guard` (0156), re-created with one addition: a correction moves a
-- hand-settled proposal send between succeeded and reconciled.
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
      -- [0161] A correction moves a hand-settled proposal send between delivered (succeeded) and
      -- [0161] not delivered (reconciled), only when that correction is the newest answer in the
      -- [0161] send's chain, the move carries its time, and the send has not moved on since.
      (OLD.state = 'succeeded' AND NEW.state = 'reconciled' AND EXISTS ( -- [0161]
        SELECT 1 FROM proposal_delivery_corrections correction -- [0161]
         WHERE correction.effect_id = OLD.effect_id -- [0161]
           AND correction.outcome = 'not_delivered' -- [0161]
           AND correction.created_at = NEW.updated_at -- [0161]
           AND julianday(correction.created_at) >= julianday(OLD.updated_at) -- [0161]
           AND NOT EXISTS ( -- [0161]
             SELECT 1 FROM proposal_delivery_corrections later -- [0161]
              WHERE later.supersedes_correction_id = correction.correction_id))) OR -- [0161]
      (OLD.state = 'reconciled' AND NEW.state = 'succeeded' AND EXISTS ( -- [0161]
        SELECT 1 FROM proposal_delivery_corrections correction -- [0161]
         WHERE correction.effect_id = OLD.effect_id -- [0161]
           AND correction.outcome = 'delivered' -- [0161]
           AND correction.created_at = NEW.updated_at -- [0161]
           AND julianday(correction.created_at) >= julianday(OLD.updated_at) -- [0161]
           AND NOT EXISTS ( -- [0161]
             SELECT 1 FROM proposal_delivery_corrections later -- [0161]
              WHERE later.supersedes_correction_id = correction.correction_id))) OR -- [0161]
      (OLD.state = 'manual_exception' AND NEW.state IN ('succeeded', 'reconciled'))
    );
END;

CREATE TABLE IF NOT EXISTS commercial_proposal_publication_recorders (
  publication_event_id TEXT PRIMARY KEY CHECK (
    length(publication_event_id) BETWEEN 20 AND 120
    AND publication_event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  recorded_by_user_id TEXT NOT NULL CHECK (length(recorded_by_user_id) BETWEEN 3 AND 128),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40)
);

CREATE TRIGGER IF NOT EXISTS commercial_proposal_publication_recorders_validate_insert
BEFORE INSERT ON commercial_proposal_publication_recorders BEGIN
  -- A recorder is written just before its publication event, never added to one already recorded.
  SELECT RAISE(ABORT, 'commercial_publication_recorder_after_event')
    WHERE EXISTS (
      SELECT 1 FROM commercial_proposal_publication_events publication
       WHERE publication.publication_event_id = NEW.publication_event_id
    );
  SELECT RAISE(ABORT, 'commercial_publication_recorder_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM app_users person
       WHERE person.tenant_id = NEW.tenant_id
         AND person.user_id = NEW.recorded_by_user_id
         AND person.active = 1
    );
END;

CREATE TRIGGER IF NOT EXISTS commercial_proposal_publication_recorders_append_only_update
BEFORE UPDATE ON commercial_proposal_publication_recorders BEGIN
  SELECT RAISE(ABORT, 'commercial_proposal_publication_recorders_append_only');
END;

CREATE TRIGGER IF NOT EXISTS commercial_proposal_publication_recorders_append_only_delete
BEFORE DELETE ON commercial_proposal_publication_recorders BEGIN
  SELECT RAISE(ABORT, 'commercial_proposal_publication_recorders_append_only');
END;

-- Every publication event recorded from now on names who recorded it, at the event's own time.
CREATE TRIGGER IF NOT EXISTS commercial_publication_recorder_guard
BEFORE INSERT ON commercial_proposal_publication_events BEGIN
  SELECT RAISE(ABORT, 'commercial_publication_recorder_required')
    WHERE NOT EXISTS (
      SELECT 1 FROM commercial_proposal_publication_recorders recorder
       WHERE recorder.publication_event_id = NEW.publication_event_id
         AND recorder.tenant_id = NEW.tenant_id
         AND recorder.recorded_at = NEW.occurred_at
    );
END;
