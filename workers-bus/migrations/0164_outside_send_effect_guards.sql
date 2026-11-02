-- 0164_outside_send_effect_guards.sql - an outside proposal send is settled from evidence, never
-- from a caller's word, and is never retried.
--
-- A proposal send runs once. Its retry limit is 0 from the start, and it never enters `retry`: a
-- second attempt at the same revision is a new effect, which the 0156 single-flight guard admits
-- only once the last send is settled. An `unknown` proposal send (publish or withdraw) moves to
-- `succeeded` or `reconciled` only with a matching person confirmation of the same tenant (0156).
-- An executor's own report of a match or a reconcile is not evidence that the customer received
-- anything. 0156 records confirmations for publish only, so an unknown withdraw stays unknown, or
-- goes to a person as an exception, until its creator brings an evidence path of its own. The
-- evidence guard is keyed on the action alone: the aggregate type is the claimer's own word, and
-- every path that binds or records a proposal send (the 0093 permit binding, the publication
-- record, the QA seed) already requires `proposal_publication`, so a send claimed under any other
-- type is held all the same.
-- `manual_exception` keeps its 0156 exit, and the 0156 apply trigger inserts the confirmation
-- before it moves the effect, so the person path passes this guard.
--
-- The conflict rule. A person never records `not_delivered` for a send whose provider answered.
-- That is a send whose latest move into `manual_exception` (the same event 0161's late-answer wait
-- reads) came from:
--   - `reconciling`: the provider answered and its readback conflicted; or
--   - `failed`: the provider refused it, yet a later check says it ran or cannot tell
--     (`effect_reconciliation_conflicts_with_failure`, or an inconclusive check of a failed send).
-- "Not delivered" would make such a send "not executed" and open the way to a second send. That
-- needs provider evidence; until then the send stays an exception. A person may still record that
-- the customer has it (`delivered`). A send whose latest move came from `unknown` (a provider that
-- never answered) keeps the 0156 person path, after 0161's wait. This guard runs on the
-- confirmation insert, before 0156's apply trigger moves the effect and before 0161's wait is
-- read, so the refusal is this guard's at any time.
--
-- New triggers with distinct names only. No 0042, 0156 or 0161 trigger is re-created. Each uses
-- CREATE TRIGGER IF NOT EXISTS and references only 0042 and 0156 objects, so this file applies the
-- same before or after 0161. 0161's late-answer wait and this file's evidence guard both refuse an
-- unknown send's early move to "not executed"; which answers first is not part of either contract.
--
-- PR-A (0167) re-creates two of these guards under the same names: the conflict guard and the
-- evidence guard. It always runs after this file in filename order, so it DROPs TRIGGER IF EXISTS
-- each one and CREATEs it again, replacing this file's version. Each re-created guard must carry
-- this file's rules unchanged:
--   - the widened origin rule: `not_delivered` is refused when the send's own latest move into
--     `manual_exception` has origin IN ('reconciling', 'failed');
--   - the withdraw clauses: `proposal.withdraw` stays beside `proposal.publish`, so an unknown
--     withdrawal needs evidence too;
--   - the action-keyed evidence guard: keyed on OLD.action alone, never on the aggregate type.
-- Applying this file again after PR-A changes nothing: IF NOT EXISTS keeps PR-A's version.
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
  AND OLD.action IN ('proposal.publish', 'proposal.withdraw')
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
    WHERE (
      SELECT event.from_state FROM external_effect_events event
       WHERE event.effect_id = NEW.effect_id AND event.to_state = 'manual_exception'
       ORDER BY event.event_seq DESC LIMIT 1
    ) IN ('reconciling', 'failed');
END;
