-- 0164_outside_send_effect_guards.sql - an outside proposal send is settled from evidence, never
-- from a caller's word, and is never retried.
--
-- A proposal send runs once. Its retry limit is 0 from the start, and it never enters `retry`: a
-- second attempt at the same revision is a new effect, which the 0156 single-flight guard admits
-- only once the last send is settled. An `unknown` proposal send moves to `succeeded` or
-- `reconciled` only with a matching person confirmation (0156). An executor's own report of a
-- match or a reconcile is not evidence that the customer received anything. `manual_exception`
-- keeps its 0156 exit, and the 0156 apply trigger inserts the confirmation before it moves the
-- effect, so the person path passes this guard.
--
-- A send whose readback conflicted went straight from `reconciling` to `manual_exception`: the
-- provider answered, so it did something. A person may record that the customer has it
-- (`delivered`), but never `not_delivered`, which would make the send "not executed" and open the
-- way to a second send. That needs provider evidence; until then the send stays an exception. A
-- send that went `unknown` first (a provider that never answered) keeps the 0156 person path. This
-- guard runs on the confirmation insert, before 0156's apply trigger moves the effect. A send whose
-- readback conflicted never went `unknown`, so a late-answer wait has nothing to hold for it: the
-- refusal is this guard's, whatever order the insert guards run in.
--
-- New triggers with distinct names only. No 0042, 0156 or 0161 trigger is re-created. Each uses
-- CREATE TRIGGER IF NOT EXISTS and references only 0042 and 0156 objects, so this file is
-- safe whether it is applied before 0161 and 0162 (production order) or after them (a fresh
-- database, filename order).
--
-- PR-A (0162) and, only if needed, the reworked 0161 extend the evidence guard. They DROP TRIGGER
-- IF EXISTS and CREATE it again under the same name, carrying this clause unchanged. On a fresh
-- database their CREATE runs first and this file's IF NOT EXISTS skips; in production this file
-- runs first and theirs replaces it. Both end with the same trigger.
--
-- Existing rows need no data step: every proposal send so far was created with the default retry
-- limit of 0, and `proposal.withdraw` has no creator yet. `customer.email.send` and
-- `operations.email.send` keep their retry limit of 1 and their retry after `failed`.

CREATE TRIGGER IF NOT EXISTS external_effects_outside_send_retry_limit_guard
BEFORE INSERT ON external_effects
WHEN NEW.action IN ('proposal.publish', 'proposal.withdraw') AND NEW.retry_limit != 0
BEGIN
  SELECT RAISE(ABORT, 'outside_send_retry_limit_invalid');
END;

CREATE TRIGGER IF NOT EXISTS external_effects_outside_send_no_retry_guard
BEFORE UPDATE OF state ON external_effects
WHEN OLD.action IN ('proposal.publish', 'proposal.withdraw') AND NEW.state = 'retry'
BEGIN
  SELECT RAISE(ABORT, 'outside_send_retry_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS external_effects_proposal_settle_evidence_guard
BEFORE UPDATE OF state ON external_effects
WHEN OLD.state = 'unknown' AND NEW.state IN ('succeeded', 'reconciled')
  AND OLD.action = 'proposal.publish' AND OLD.aggregate_type = 'proposal_publication'
BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_settle_evidence_missing')
    WHERE NOT EXISTS (
      SELECT 1 FROM proposal_delivery_confirmations confirmation
       WHERE confirmation.effect_id = OLD.effect_id
         AND confirmation.tenant_id = OLD.tenant_id
         AND confirmation.outcome =
           CASE NEW.state WHEN 'succeeded' THEN 'delivered' ELSE 'not_delivered' END
    );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_confirmations_conflict_guard
BEFORE INSERT ON proposal_delivery_confirmations
WHEN NEW.outcome = 'not_delivered'
BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_confirmation_conflict_needs_provider_evidence')
    WHERE EXISTS (
      SELECT 1 FROM external_effect_events event
       WHERE event.effect_id = NEW.effect_id
         AND event.event_type = 'manual_exception'
         AND event.from_state = 'reconciling'
    );
END;
