-- 0161_proposal_delivery_corrections.sql - what people found about a proposal send, and their
-- corrections of it; the wait for a late provider answer held in D1 with a window per provider;
-- and the person who recorded each new proposal publication.
--
-- Findings. A person records what they found about a settled proposal send, and may correct it,
-- in `proposal_delivery_findings`: append-only rows that never change the send itself. A person
-- finds that the customer has the proposal (`delivered`) or says they did not get it
-- (`not_received`). A person cannot know whether the provider executed a send, so "not executed"
-- is never a person's finding: it comes only from provider proof, in the effect ledger. Each
-- finding keeps the state of the send's last attempt when it was recorded (`succeeded` or
-- `unknown`), so a reader can tell "they say they did not get it, and the provider confirmed the
-- send" from "they say they did not get it, and the provider never answered". The first finding
-- of a send supersedes nothing; a correction supersedes the newest finding of the same send, so
-- each finding can be superseded once and a fork is refused. Earlier findings stay as the history.
-- A finding can be recorded until the next send of that proposal or the customer's decision on
-- it, and its insert writes one audit_log row. The send's state stays what the effect runtime and
-- 0156's first confirmation made it.
--
-- Late answers. Nothing moves an unknown proposal send to "not executed" (`reconciled`) before its
-- provider's own answer can no longer arrive: neither a person's "not delivered" (0156's apply
-- makes that move) nor the effect runtime's reconcile. That covers a send that went from unknown
-- to a manual exception first. The window is counted from the end of the send's last attempt. It
-- comes from `proposal_delivery_late_answer_windows`, the one place that holds it: the provider's
-- row, else the default row `*`. Each row says where its value comes from.
--
-- Recorded by. For every new publication event recorded under a permit, D1 writes a
-- `commercial_proposal_publication_recorders` row in the insert's own statement. It names the
-- person who holds that permit, read from the permit itself. The recorder is a table of its own,
-- not a column, because the final-invoice basis hashes whole publication rows (`SELECT *`). Older
-- publications have no recorder.
--
-- 0161 only adds objects: it re-creates no trigger from 0042 or 0156, or from any other migration.

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

CREATE TRIGGER IF NOT EXISTS proposal_delivery_late_answer_windows_no_insert_replace
BEFORE INSERT ON proposal_delivery_late_answer_windows BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_late_answer_windows_append_only')
    WHERE EXISTS (
      SELECT 1 FROM proposal_delivery_late_answer_windows prior WHERE prior.provider = NEW.provider
    );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_late_answer_windows_append_only_update
BEFORE UPDATE ON proposal_delivery_late_answer_windows BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_late_answer_windows_append_only');
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_late_answer_windows_append_only_delete
BEFORE DELETE ON proposal_delivery_late_answer_windows BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_late_answer_windows_append_only');
END;

-- The send has not answered and its provider's late answer could still arrive: it went unknown
-- (now or before a manual exception), and the end of its last attempt plus the window is later
-- than the move.
CREATE TRIGGER IF NOT EXISTS external_effects_proposal_late_answer_guard
BEFORE UPDATE OF state ON external_effects
WHEN NEW.state = 'reconciled' AND OLD.state IN ('unknown', 'manual_exception')
  AND OLD.action = 'proposal.publish' AND OLD.aggregate_type = 'proposal_publication'
BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_answer_may_be_late')
    WHERE (
      OLD.state = 'unknown'
      OR EXISTS (
        SELECT 1 FROM external_effect_events event
         WHERE event.effect_id = OLD.effect_id AND event.to_state = 'unknown'
      )
    )
    AND julianday(NEW.updated_at) < julianday(COALESCE(
      (SELECT attempt.ended_at FROM external_effect_attempts attempt
        WHERE attempt.effect_id = OLD.effect_id AND attempt.attempt_number = OLD.attempt_count),
      OLD.updated_at
    )) + COALESCE(
      (SELECT late.window_ms FROM proposal_delivery_late_answer_windows late
        WHERE late.provider = OLD.provider),
      (SELECT late.window_ms FROM proposal_delivery_late_answer_windows late
        WHERE late.provider = '*')
    ) / 86400000.0;
END;

CREATE TABLE IF NOT EXISTS proposal_delivery_findings (
  finding_id TEXT PRIMARY KEY CHECK (length(finding_id) BETWEEN 16 AND 200),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 128),
  effect_id TEXT NOT NULL,
  proposal_pack_id TEXT NOT NULL CHECK (length(proposal_pack_id) BETWEEN 1 AND 160),
  proposal_revision_id TEXT NOT NULL CHECK (length(proposal_revision_id) BETWEEN 1 AND 160),
  finding TEXT NOT NULL CHECK (finding IN ('delivered', 'not_received')),
  attempt_state TEXT NOT NULL CHECK (attempt_state IN ('succeeded', 'unknown')),
  supersedes_finding_id TEXT UNIQUE,
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 8 AND 500),
  found_by_user_id TEXT NOT NULL CHECK (length(found_by_user_id) BETWEEN 3 AND 128),
  found_by_role TEXT NOT NULL CHECK (found_by_role IN ('owner', 'ops', 'sales')),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_finding_id)
    REFERENCES proposal_delivery_findings(finding_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_proposal_delivery_findings_effect
  ON proposal_delivery_findings (tenant_id, effect_id, created_at);

CREATE TRIGGER IF NOT EXISTS proposal_delivery_findings_validate_insert
BEFORE INSERT ON proposal_delivery_findings BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_finding_exists')
    WHERE EXISTS (
      SELECT 1 FROM proposal_delivery_findings prior
       WHERE prior.finding_id = NEW.finding_id
          OR (prior.tenant_id = NEW.tenant_id
              AND prior.idempotency_key_hash = NEW.idempotency_key_hash)
    );
  -- One first finding per send, and each finding superseded once: only the newest is corrected,
  -- so the history never forks.
  SELECT RAISE(ABORT, 'proposal_delivery_finding_not_latest')
    WHERE (NEW.supersedes_finding_id IS NULL AND EXISTS (
            SELECT 1 FROM proposal_delivery_findings prior
             WHERE prior.tenant_id = NEW.tenant_id AND prior.effect_id = NEW.effect_id
          ))
       OR EXISTS (
            SELECT 1 FROM proposal_delivery_findings later
             WHERE later.supersedes_finding_id = NEW.supersedes_finding_id
          );
  SELECT RAISE(ABORT, 'proposal_delivery_finding_chain_invalid')
    WHERE NEW.supersedes_finding_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM proposal_delivery_findings earlier
       WHERE earlier.finding_id = NEW.supersedes_finding_id
         AND earlier.tenant_id = NEW.tenant_id
         AND earlier.effect_id = NEW.effect_id
         AND earlier.proposal_pack_id = NEW.proposal_pack_id
         AND earlier.proposal_revision_id = NEW.proposal_revision_id
    );
  -- About a settled proposal send of this tenant: one the effect runtime or 0156's first
  -- confirmation already settled.
  SELECT RAISE(ABORT, 'proposal_delivery_finding_effect_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.action = 'proposal.publish'
         AND effect.aggregate_type = 'proposal_publication'
         AND effect.aggregate_id = NEW.proposal_pack_id
         AND effect.intent_id = NEW.proposal_revision_id
         AND effect.state IN ('succeeded', 'reconciled')
    );
  -- The attempt state it keeps is the send's last attempt as it stands.
  SELECT RAISE(ABORT, 'proposal_delivery_finding_attempt_mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
        JOIN external_effect_attempts attempt
          ON attempt.effect_id = effect.effect_id AND attempt.attempt_number = effect.attempt_count
       WHERE effect.effect_id = NEW.effect_id AND attempt.state = NEW.attempt_state
    );
  -- Open until the next send of this proposal or the customer's decision on it.
  SELECT RAISE(ABORT, 'proposal_delivery_finding_closed')
    WHERE EXISTS (
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
  SELECT RAISE(ABORT, 'proposal_delivery_finding_actor_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM app_users person
       WHERE person.tenant_id = NEW.tenant_id
         AND person.user_id = NEW.found_by_user_id
         AND person.active = 1
         AND person.access_role = NEW.found_by_role
    );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_findings_audit
AFTER INSERT ON proposal_delivery_findings BEGIN
  INSERT INTO audit_log
    (ts, automation, trigger, envelope_id, source_ids, target_ids, action, result, approved_by)
  VALUES (
    NEW.created_at, 'proposal_delivery', 'office', NULL,
    'finding:' || NEW.finding_id || COALESCE(',supersedes:' || NEW.supersedes_finding_id, ''),
    'effect:' || NEW.effect_id || ',proposal:' || NEW.proposal_revision_id,
    'proposal_delivery_finding_' || NEW.finding, 'ok', NEW.found_by_user_id
  );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_findings_append_only_update
BEFORE UPDATE ON proposal_delivery_findings BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_findings_append_only');
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_findings_append_only_delete
BEFORE DELETE ON proposal_delivery_findings BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_findings_append_only');
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
  recorded_by_user_id TEXT NOT NULL CHECK (length(recorded_by_user_id) BETWEEN 1 AND 160),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40)
);

-- A recorder row is exactly the permit holder of an existing publication event, at its time.
CREATE TRIGGER IF NOT EXISTS commercial_proposal_publication_recorders_validate_insert
BEFORE INSERT ON commercial_proposal_publication_recorders BEGIN
  SELECT RAISE(ABORT, 'commercial_publication_recorder_exists')
    WHERE EXISTS (
      SELECT 1 FROM commercial_proposal_publication_recorders prior
       WHERE prior.publication_event_id = NEW.publication_event_id
    );
  SELECT RAISE(ABORT, 'commercial_publication_recorder_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM commercial_proposal_publication_events publication
        JOIN commercial_authority_permits permit
          ON permit.permit_id = publication.policy_permit_id
         AND permit.tenant_id = publication.tenant_id
       WHERE publication.publication_event_id = NEW.publication_event_id
         AND publication.tenant_id = NEW.tenant_id
         AND publication.occurred_at = NEW.recorded_at
         AND permit.actor_id = NEW.recorded_by_user_id
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

-- Each publication event recorded under a permit names its permit holder, in the insert's own
-- statement, whichever Worker inserts it.
CREATE TRIGGER IF NOT EXISTS commercial_publication_recorder_from_permit
AFTER INSERT ON commercial_proposal_publication_events
WHEN NEW.policy_permit_id IS NOT NULL
BEGIN
  INSERT INTO commercial_proposal_publication_recorders
    (publication_event_id, tenant_id, recorded_by_user_id, recorded_at)
  SELECT NEW.publication_event_id, NEW.tenant_id, permit.actor_id, NEW.occurred_at
    FROM commercial_authority_permits permit
   WHERE permit.permit_id = NEW.policy_permit_id AND permit.tenant_id = NEW.tenant_id;
END;
