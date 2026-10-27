-- 0167_proposal_delivery_checks.sql - a person asks the email service what it knows about one
-- proposal send, and the answer is kept; a send whose provider answered may then be recorded as
-- not delivered, but only on that provider evidence.
--
-- Checks (#15b-1b). A person taps "Check delivery" and the bus reads back, inside that person's own
-- request, what the provider knows about one `proposal.publish` send. One append-only row keeps the
-- answer: `sent`, `bounced`, `not_found`, `unknown`, or `provider_unavailable` (the provider did not
-- answer: a timeout, a network error, a 5xx or an open breaker). `not_found` means a complete scan
-- found nothing, so it needs `scan_complete = 1`, and it is refused before the provider's own late
-- answer could still arrive (the end of the send's last attempt plus its window from 0161). No
-- adapter can scan completely before Proof P1, so no `not_found` row is written until then. There is
-- no executor, claim, lease or expiry: a check that cannot finish writes nothing. A check never
-- creates an effect, a permit or a send, and nothing here moves a send. Each check writes one
-- audit_log row, at most 20 checks of each kind (citable, found, other) are kept per send, and the
-- row is dated by the Worker's clock as the readback starts, which D1 compares with its own. The
-- person who asked is named on the row and must be an active account holder in that role.
--
-- PR-S's evidence guard (0164) is re-created under its name. It carries 0164's text unchanged
-- (keyed on the action alone, publish and withdraw, a confirmation of the same tenant with the
-- matching outcome) and adds the check rows that will justify a move from B2 on: a `sent` or
-- `bounced` row for unknown -> succeeded, a complete-scan `not_found` row for unknown -> reconciled,
-- each bound to the move by `created_at = NEW.updated_at`, as 0161 binds a correction to its move.
-- A "not found" never justifies the move once a check of the send found the message sent. No Worker
-- path makes either move from a check yet.
--
-- The recorder. A send that a check moves to succeeded is then recorded as the publication (B2), and
-- that record names the send's permit holder (0161, `permit_holder_user_id`, read from the permit).
-- So a check-justified move to succeeded needs the send's own permit, of the same tenant: a send
-- with none is refused by name (`proposal_delivery_settle_permit_holder_missing`) and stays for a
-- person's record, never moved with no one to record it. A person's own confirmation needs no permit
-- here: that person records it. A move to reconciled records no publication, so it needs none.
--
-- The conflict hole. A send whose provider answered has its latest move into manual_exception from
-- `reconciling` (its readback conflicted) or from `failed` (it refused the send, yet a later check
-- says it ran or cannot tell). 0164 never lets a person record it as not delivered, and nothing else
-- settled it. A person's "not delivered" on such a send now passes when it cites a check of that same
-- send, newer than that move, that scanned completely without finding the send (`not_found`,
-- `scan_complete = 1`). Until a check can scan completely (Proof P1), such a send stays an exception:
-- it fails safe. The confirmation names the check it cites in a new nullable column; only "not
-- delivered" cites one, and a cited check is always a complete-scan `not_found` of the same send.
--
-- A found message. A check that found the message sent (`sent`, before or after any other check: a
-- lagging mailbox may show it only later) proves the send was executed. So no person records such a
-- send as not delivered, cited or not, through 0156's path or out of a conflict; "delivered" stays
-- open. A bounce is not such a check: the customer did not get the message, and "not delivered" stays
-- the way to send again (frame 1·b).
--
-- 0164's conflict guard is re-created under its name with these rules; its own text is carried
-- unchanged, so "delivered" and a silent provider's path with no found message (a manual exception
-- that came from unknown, after 0161's wait) are unchanged.
--
-- Numbered 0167, above 0164 (PR-S), 0165 (L06) and the reserved 0166, so its DROP and CREATE of
-- 0164's two guards run after 0164 both on a fresh database and in production; 0164 is never edited.
-- 0200-0206 touch none of the objects this file creates, alters or re-creates, so its landing after
-- them applies the same as filename order. Not touched: the 0042, 0093, 0156 and 0161 triggers and
-- every gate-train object.

CREATE TABLE IF NOT EXISTS proposal_delivery_checks (
  check_id TEXT PRIMARY KEY CHECK (length(check_id) BETWEEN 16 AND 200),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 128),
  effect_id TEXT NOT NULL,
  proposal_pack_id TEXT NOT NULL CHECK (length(proposal_pack_id) BETWEEN 1 AND 160),
  proposal_revision_id TEXT NOT NULL CHECK (length(proposal_revision_id) BETWEEN 1 AND 160),
  effect_state TEXT NOT NULL CHECK (effect_state IN ('unknown', 'succeeded', 'manual_exception')),
  requested_by_user_id TEXT NOT NULL CHECK (length(requested_by_user_id) BETWEEN 3 AND 128),
  requested_by_role TEXT NOT NULL CHECK (requested_by_role IN ('owner', 'ops', 'sales')),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('sent', 'bounced', 'not_found', 'unknown', 'provider_unavailable')
  ),
  scan_complete INTEGER NOT NULL DEFAULT 0 CHECK (scan_complete IN (0, 1)),
  provider_external_id TEXT CHECK (
    provider_external_id IS NULL OR length(provider_external_id) BETWEEN 1 AND 160
  ),
  evidence_sha256 TEXT CHECK (
    evidence_sha256 IS NULL OR (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  unavailable_since TEXT CHECK (unavailable_since IS NULL OR length(unavailable_since) BETWEEN 20 AND 40),
  detail_code TEXT CHECK (
    detail_code IS NULL OR (length(detail_code) BETWEEN 3 AND 120 AND detail_code NOT GLOB '*[^a-z0-9_:-]*')
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  CHECK (outcome NOT IN ('sent', 'bounced', 'not_found') OR evidence_sha256 IS NOT NULL),
  -- A sent attempt is only ever checked for a bounce: "not found" is about an unconfirmed send.
  CHECK (outcome != 'not_found' OR (scan_complete = 1 AND effect_state IN ('unknown', 'manual_exception'))),
  CHECK ((outcome = 'provider_unavailable') = (unavailable_since IS NOT NULL)),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_proposal_delivery_checks_effect
  ON proposal_delivery_checks (tenant_id, effect_id, created_at);

CREATE TRIGGER IF NOT EXISTS proposal_delivery_checks_validate_insert
BEFORE INSERT ON proposal_delivery_checks BEGIN
  -- Dated by the Worker's clock, within a minute of D1's own.
  SELECT RAISE(ABORT, 'proposal_delivery_check_clock_skew')
    WHERE julianday(NEW.created_at) IS NULL
       OR abs(julianday(NEW.created_at) - julianday('now')) * 86400.0 > 60;
  -- One row per check and per idempotency key; this also refuses an insert-replace (0062).
  SELECT RAISE(ABORT, 'proposal_delivery_check_exists')
    WHERE EXISTS (
      SELECT 1 FROM proposal_delivery_checks prior
       WHERE prior.check_id = NEW.check_id
          OR (prior.tenant_id = NEW.tenant_id AND prior.idempotency_key_hash = NEW.idempotency_key_hash)
    );
  -- About a proposal send of this tenant, pack and revision, in the state the check saw.
  SELECT RAISE(ABORT, 'proposal_delivery_check_effect_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.action = 'proposal.publish'
         AND effect.aggregate_type = 'proposal_publication'
         AND effect.aggregate_id = NEW.proposal_pack_id
         AND effect.intent_id = NEW.proposal_revision_id
         AND effect.state = NEW.effect_state
    );
  -- "Not found" only once the provider's own late answer can no longer arrive: the end of the
  -- send's last attempt plus its provider's window (0161), else the default row, else the lease.
  SELECT RAISE(ABORT, 'proposal_delivery_check_too_early')
    WHERE NEW.outcome = 'not_found' AND EXISTS (
      SELECT 1 FROM external_effects effect
        LEFT JOIN external_effect_attempts attempt
          ON attempt.effect_id = effect.effect_id AND attempt.attempt_number = effect.attempt_count
       WHERE effect.effect_id = NEW.effect_id
         AND julianday(NEW.created_at) < julianday(COALESCE(attempt.ended_at, effect.updated_at)) + COALESCE(
           (SELECT late.window_ms FROM proposal_delivery_late_answer_windows late
             WHERE late.provider = effect.provider),
           (SELECT late.window_ms FROM proposal_delivery_late_answer_windows late
             WHERE late.provider = '*'),
           120000
         ) / 86400000.0
    );
  -- At most 20 checks of each kind per send: a citable check (a complete-scan "not found"), a check
  -- that found the message (`sent`), and every other answer each have their own room, so answers that
  -- prove nothing can never use up the room the proof needs, or the room a found message needs.
  SELECT RAISE(ABORT, 'proposal_delivery_check_limit')
    WHERE (
      SELECT count(*) FROM proposal_delivery_checks prior
       WHERE prior.tenant_id = NEW.tenant_id AND prior.effect_id = NEW.effect_id
         AND (CASE prior.outcome WHEN 'not_found' THEN 1 WHEN 'sent' THEN 2 ELSE 0 END)
           = (CASE NEW.outcome WHEN 'not_found' THEN 1 WHEN 'sent' THEN 2 ELSE 0 END)
    ) >= 20;
  SELECT RAISE(ABORT, 'proposal_delivery_check_actor_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM app_users person
       WHERE person.tenant_id = NEW.tenant_id
         AND person.user_id = NEW.requested_by_user_id
         AND person.active = 1
         AND person.access_role = NEW.requested_by_role
    );
  SELECT RAISE(ABORT, 'proposal_delivery_check_unavailable_since_invalid')
    WHERE NEW.unavailable_since IS NOT NULL
      AND (julianday(NEW.unavailable_since) IS NULL
           OR julianday(NEW.unavailable_since) > julianday(NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_checks_audit
AFTER INSERT ON proposal_delivery_checks BEGIN
  INSERT INTO audit_log
    (ts, automation, trigger, envelope_id, source_ids, target_ids, action, result, approved_by)
  VALUES (
    NEW.created_at, 'proposal_delivery', 'office', NULL,
    'check:' || NEW.check_id,
    'effect:' || NEW.effect_id || ',proposal:' || NEW.proposal_revision_id,
    'proposal_delivery_check_' || NEW.outcome, 'ok', NEW.requested_by_user_id
  );
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_checks_append_only_update
BEFORE UPDATE ON proposal_delivery_checks BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_checks_append_only');
END;

CREATE TRIGGER IF NOT EXISTS proposal_delivery_checks_append_only_delete
BEFORE DELETE ON proposal_delivery_checks BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_checks_append_only');
END;

-- The check a person's "not delivered" cites as provider evidence. Every existing confirmation
-- cites none. The conflict guard below proves each citation names a check of the same tenant and
-- send, and checks are append-only, so a citation never dangles. It carries no foreign key: that
-- would point from 0156's table to this newer one and make a restore insert a child before its
-- parent.
ALTER TABLE proposal_delivery_confirmations ADD COLUMN delivery_check_id TEXT
  CHECK (delivery_check_id IS NULL OR (outcome = 'not_delivered' AND length(delivery_check_id) BETWEEN 16 AND 200));

-- PR-S's guard (0164), under its name: an unknown proposal send moves to succeeded or reconciled
-- only with a person's matching confirmation (0164, carried unchanged) or, from B2 on, a check row of
-- the send dated at the move. A check-justified move to succeeded also needs the send's permit, whose
-- holder records the publication that follows.
DROP TRIGGER IF EXISTS external_effects_proposal_settle_evidence_guard;
CREATE TRIGGER external_effects_proposal_settle_evidence_guard
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
    )
    AND NOT EXISTS (
      SELECT 1 FROM proposal_delivery_checks delivery_check
       WHERE delivery_check.effect_id = OLD.effect_id
         AND delivery_check.tenant_id = OLD.tenant_id
         AND delivery_check.created_at = NEW.updated_at
         AND (
           (NEW.state = 'succeeded' AND delivery_check.outcome IN ('sent', 'bounced'))
           OR (NEW.state = 'reconciled' AND delivery_check.outcome = 'not_found'
               AND delivery_check.scan_complete = 1
               AND NOT EXISTS (
                 SELECT 1 FROM proposal_delivery_checks found
                  WHERE found.effect_id = OLD.effect_id
                    AND found.tenant_id = OLD.tenant_id
                    AND found.outcome = 'sent'
               ))
         )
    );
  SELECT RAISE(ABORT, 'proposal_delivery_settle_permit_holder_missing')
    WHERE NEW.state = 'succeeded'
      AND NOT EXISTS (
        SELECT 1 FROM proposal_delivery_confirmations confirmation
         WHERE confirmation.effect_id = OLD.effect_id
           AND confirmation.tenant_id = OLD.tenant_id
           AND confirmation.outcome = 'delivered'
      )
      AND NOT EXISTS (
        SELECT 1 FROM commercial_authority_permits permit
         WHERE permit.permit_id = OLD.authority_ref
           AND permit.tenant_id = OLD.tenant_id
      );
END;

-- 0164's conflict guard, under its name, its own text carried unchanged. A cited check is a
-- complete-scan `not_found` of the same send. No "not delivered" passes once a check of the send
-- found the message sent. A "not delivered" on a send whose provider answered (its latest move into
-- manual_exception came from reconciling or failed) passes only by citing such a check made after
-- that move.
DROP TRIGGER IF EXISTS proposal_delivery_confirmations_conflict_guard;
CREATE TRIGGER proposal_delivery_confirmations_conflict_guard
BEFORE INSERT ON proposal_delivery_confirmations
WHEN NEW.outcome = 'not_delivered'
BEGIN
  SELECT RAISE(ABORT, 'proposal_delivery_confirmation_check_invalid')
    WHERE NEW.delivery_check_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM proposal_delivery_checks delivery_check
       WHERE delivery_check.check_id = NEW.delivery_check_id
         AND delivery_check.tenant_id = NEW.tenant_id
         AND delivery_check.effect_id = NEW.effect_id
         AND delivery_check.outcome = 'not_found'
         AND delivery_check.scan_complete = 1
    );
  -- A check of the send that found the message sent contradicts every "not delivered" of it, cited
  -- or not, whichever came first: the provider sent it, so it was executed. A bounce does not: the
  -- customer did not get it, and "not delivered" stays the way to send again (frame 1·b).
  SELECT RAISE(ABORT, 'proposal_delivery_confirmation_check_contradicted')
    WHERE EXISTS (
      SELECT 1 FROM proposal_delivery_checks found
       WHERE found.effect_id = NEW.effect_id
         AND found.tenant_id = NEW.tenant_id
         AND found.outcome = 'sent'
    );
  SELECT RAISE(ABORT, 'proposal_delivery_confirmation_conflict_needs_provider_evidence')
    WHERE (
      SELECT event.from_state FROM external_effect_events event
       WHERE event.effect_id = NEW.effect_id AND event.to_state = 'manual_exception'
       ORDER BY event.event_seq DESC LIMIT 1
    ) IN ('reconciling', 'failed')
    AND NOT EXISTS (
      -- The cited check, which the statement above has proved, made after that move.
      SELECT 1 FROM proposal_delivery_checks delivery_check
       WHERE delivery_check.check_id = NEW.delivery_check_id
         AND julianday(delivery_check.created_at) > julianday((
           SELECT event.occurred_at FROM external_effect_events event
            WHERE event.effect_id = NEW.effect_id AND event.to_state = 'manual_exception'
            ORDER BY event.event_seq DESC LIMIT 1
         ))
    );
END;
