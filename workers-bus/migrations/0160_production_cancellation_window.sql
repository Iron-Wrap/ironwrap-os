-- 0160_production_cancellation_window.sql - the OD-01 cancellation window holds ordering and a
-- firm start until it ends.
--
-- OD-01 (the owner's register, as the lead ruled it, pending counsel through the owner): the
-- customer may cancel until 10 days after they receive their copy of the signed contract, and
-- inside that window nothing is ordered from a supplier, no shop work starts and no start is
-- confirmed. The register scopes it to private dwellings; D1 cannot tell a private dwelling from a
-- commercial job, so the window applies to every contract. Of that register, this migration holds
-- the firm start, the Materials attestation and a job's purchase order lines in D1. It does not hold
-- Frappe's Supplier Order (written outside D1, through the ERPNext MCP) or a Shop Order's schedule
-- on the typed work-object assignment; each needs this hold before it opens.
--
-- The window starts from one of two records of that receipt:
--
-- 1. `contract_signed_copy_events`: the portal served the customer the signed copy. By the owner's
--    ruling a copy shown in the portal at signing counts as received. The Worker appends an event
--    only after the acceptance has committed and it has built the copy (terms plus receipt) for a
--    client that renders it, in its own statement conditional on that committed binding; never
--    from the acceptance alone, and never for a copy it could not build. The window starts at the
--    event's D1 write time, `shown_at`, D1's own clock. The Worker then confirms the copy served
--    (`contract_signed_copy_served`, append-only, D1's clock, within a minute of its event) and
--    only then sends it. An event with no confirmation (the Worker stopped, or D1's answers were
--    lost past its retries) has started the window though no copy may have reached the customer:
--    the owner and ops work queue lists the job until a copy of that contract is confirmed served or
--    a person records the receipt. A later attempt never reuses an unconfirmed event: it appends a
--    new one with D1's time then, so a copy served later never carries a back-dated start. Once a
--    contract's copy is confirmed served, no further event is appended for it. Each event and each
--    confirmation writes one `audit_log` row as it lands.
-- 2. `production_cancellation_window_receipts`: a person's record, for a contract whose copy the
--    portal did not show (every contract signed before this, or one signed outside D1). An active
--    owner or ops person, never the QA seed owner, records when the customer received the copy,
--    with a reason and an evidence reference. The Worker takes the person's own session, so no
--    agent records one. `recorded_at` is D1's own clock; each record writes one `audit_log` row.
--    D1 refuses:
--      * a time D1 cannot read back exactly, or one after D1's now;
--      * a time before the job's latest contract signature (the `accepted_at` of its latest
--        acceptance binding; equal is allowed), and a record whose floor is not that binding. A job
--        with no binding, such as one imported from the old system, records with no floor;
--      * a time earlier than one already recorded or shown for the job, or the same time again: a
--        record only ever moves the window later.
--
-- Both carry `window_ends_at` (INTERIM, pending counsel): the end of the 10th local calendar day
-- after the day the window starts on, in the business time zone, the start's own day being day 0.
-- It is stored as the first instant of the 11th local day, an exclusive bound: the window holds
-- while D1's now is before it. The Worker reads the day by the runtime's time zone rules and across
-- every UTC offset the zone has kept in the last five years (UTC-7 and UTC-6 for Edmonton, in
-- every time zone data release), and takes the latest reading, so a runtime a release behind or
-- ahead of the real rule never ends a window early. It is never before the start + 240 hours nor
-- before the job's previous end, so whichever way counsel counts "10 days" the hold never ends
-- early, across DST too. For an event the Worker hands D1 the stretches around its own now, each
-- with its end, and D1 picks the one its own clock is in. D1 has no time zone database, so it holds
-- every end to [start + 240 hours, start + 266 hours] (a reading is at most 264 hours after a start
-- at local midnight plus the span of the zone's offsets, one hour for Edmonton; D1 allows two) and
-- to no earlier than the job's previous end: no writer can shorten a window.
--
-- The window is derived and read-only. It is not a gate: it has no ledger and no waiver.
--   * Unknown while the job has neither a copy event for its latest contract nor a record at or
--     after that contract's signature: nothing at all, or only from before a later contract.
--   * Open while any end on the job is after D1's now (ends never move earlier); ended at the end.
--   * Ended otherwise.
-- While a job's window is unknown or open, D1 refuses each of these by its own code, read with
-- D1's own clock:
--   * a schedule, the firm start (`operating_job_assignments_cancellation_window_hold`). 0098's
--     validate trigger is re-created unchanged after it, so 0098's refusals still answer first, then
--     the window, then 0159's gate evidence guard;
--   * a `clear` entry on Materials, its attestation
--     (`production_gate_clearances_cancellation_window_hold`). 0153's replace guard is re-created
--     unchanged after it, so a replayed key still answers first. A Materials waiver is allowed, and
--     it lifts no hold;
--   * a purchase order line for the job. `inventory_po_lines` gains `roof_job_id`, the line's job
--     link. A line with no job (stock, such as coil into stock) is never held. A job's line is
--     refused while that job's window holds, and so is a move back to `ordered`; the link never
--     changes once written. Placing a supplier order in D1 is that insert: a line is born
--     `ordered`. No line has a `sent` status (0067).
--
-- This file may apply after higher-numbered migrations already on a database (0200-0205 on qa and
-- production). It creates three tables and sixteen triggers, adds one column, and re-creates 0098's
-- assignment validate trigger and 0153's replace guard under their names; no higher-numbered
-- migration touches any of them.

CREATE TABLE IF NOT EXISTS contract_signed_copy_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) = 44
    AND substr(event_id, 1, 4) = 'scs_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  acceptance_binding_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  -- The signature time of the contract whose copy was shown, as its binding holds it.
  contract_signed_at TEXT NOT NULL CHECK (length(contract_signed_at) BETWEEN 20 AND 40),
  -- D1's time when the Worker, having built the signed copy, recorded it as shown: the window's
  -- start, in the form `Date.toISOString` writes.
  shown_at TEXT NOT NULL CHECK (length(shown_at) = 24),
  window_ends_at TEXT NOT NULL CHECK (length(window_ends_at) = 24),
  -- The business time zone the local clock end was read in.
  time_zone TEXT NOT NULL CHECK (
    length(time_zone) BETWEEN 3 AND 64 AND time_zone NOT GLOB '*[^A-Za-z0-9_/+-]*'
  ),
  -- More than one per contract only when an earlier one was never confirmed served.
  FOREIGN KEY (acceptance_binding_id, tenant_id)
    REFERENCES commercial_acceptance_bindings(acceptance_binding_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT
);

-- The Worker's confirmation that it served the copy an event records: written after the event and
-- before the copy is sent, with D1's clock. One per contract.
CREATE TABLE IF NOT EXISTS contract_signed_copy_served (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) = 44
    AND substr(event_id, 1, 4) = 'scs_'
    AND substr(event_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  acceptance_binding_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  -- D1's time when the Worker confirmed the copy served, in the form `Date.toISOString` writes.
  served_at TEXT NOT NULL CHECK (length(served_at) = 24),
  FOREIGN KEY (event_id) REFERENCES contract_signed_copy_events(event_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS production_cancellation_window_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 44
    AND substr(receipt_id, 1, 4) = 'pcw_'
    AND substr(receipt_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  roof_job_id TEXT NOT NULL,
  -- When the customer received their copy of the signed contract, as the person recorded it, in
  -- the form `Date.toISOString` writes.
  received_at TEXT NOT NULL CHECK (length(received_at) = 24),
  window_ends_at TEXT NOT NULL CHECK (length(window_ends_at) = 24),
  -- The business time zone the local clock end was read in.
  time_zone TEXT NOT NULL CHECK (
    length(time_zone) BETWEEN 3 AND 64 AND time_zone NOT GLOB '*[^A-Za-z0-9_/+-]*'
  ),
  -- The floor: the job's latest contract when the record was made and its signature time. Both
  -- are null when D1 holds no contract for the job.
  acceptance_binding_id TEXT,
  contract_signed_at TEXT CHECK (
    contract_signed_at IS NULL OR length(contract_signed_at) BETWEEN 20 AND 40
  ),
  -- Why the person records this time, and where it came from: a reference or a file's name.
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 300),
  recorded_by_user_id TEXT NOT NULL CHECK (
    length(recorded_by_user_id) BETWEEN 8 AND 200
    AND recorded_by_user_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  recorded_by_role TEXT NOT NULL CHECK (recorded_by_role IN ('owner', 'ops')),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (tenant_id, idempotency_key_hash),
  UNIQUE (tenant_id, roof_job_id, received_at),
  CHECK ((acceptance_binding_id IS NULL) = (contract_signed_at IS NULL)),
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (acceptance_binding_id, tenant_id)
    REFERENCES commercial_acceptance_bindings(acceptance_binding_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS contract_signed_copy_events_validate_insert
BEFORE INSERT ON contract_signed_copy_events
BEGIN
  -- REPLACE would delete the event it collides with before inserting.
  SELECT RAISE(ABORT, 'contract_signed_copy_event_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM contract_signed_copy_events existing
     WHERE existing.event_id = NEW.event_id
  );

  -- A contract whose copy is confirmed served gets no further event.
  SELECT RAISE(ABORT, 'contract_signed_copy_event_already_served')
  WHERE EXISTS (
    SELECT 1
      FROM contract_signed_copy_served served
     WHERE served.tenant_id = NEW.tenant_id
       AND served.acceptance_binding_id = NEW.acceptance_binding_id
  );

  -- The copy is of this tenant's accepted contract on this job, exactly as its binding holds it.
  SELECT RAISE(ABORT, 'contract_signed_copy_event_binding_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM commercial_acceptance_bindings binding
      JOIN customer_portal_acceptance_intents acceptance
        ON acceptance.tenant_id = binding.tenant_id
       AND acceptance.acceptance_id = binding.acceptance_id
       AND acceptance.state = 'accepted'
     WHERE binding.tenant_id = NEW.tenant_id
       AND binding.acceptance_binding_id = NEW.acceptance_binding_id
       AND binding.roof_job_id = NEW.roof_job_id
       AND binding.accepted_at = NEW.contract_signed_at
  );

  -- D1 stamps when the copy was shown, from its own clock.
  SELECT RAISE(ABORT, 'contract_signed_copy_event_shown_at_invalid')
  WHERE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.shown_at) IS NOT NEW.shown_at
     OR abs(julianday(NEW.shown_at) - julianday('now')) * 86400 > 60;

  -- Never before the start + 240 hours, never after the latest the end of the 10th local day can
  -- be (264 hours after a start at local midnight, plus a two-hour span of offsets), never before a
  -- previous end.
  SELECT RAISE(ABORT, 'contract_signed_copy_event_end_invalid')
  WHERE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.window_ends_at) IS NOT NEW.window_ends_at
     OR NEW.window_ends_at < strftime('%Y-%m-%dT%H:%M:%fZ', NEW.shown_at, '+240 hours')
     OR NEW.window_ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.shown_at, '+266 hours')
     OR EXISTS (
       SELECT 1
         FROM contract_signed_copy_events shown
        WHERE shown.tenant_id = NEW.tenant_id
          AND shown.roof_job_id = NEW.roof_job_id
          AND shown.window_ends_at > NEW.window_ends_at
     )
     OR EXISTS (
       SELECT 1
         FROM production_cancellation_window_receipts recorded
        WHERE recorded.tenant_id = NEW.tenant_id
          AND recorded.roof_job_id = NEW.roof_job_id
          AND recorded.window_ends_at > NEW.window_ends_at
     );
END;

-- One audit row per event, keyed by `run_id = event_id`.
CREATE TRIGGER IF NOT EXISTS contract_signed_copy_events_audit
AFTER INSERT ON contract_signed_copy_events
BEGIN
  INSERT INTO audit_log (
    ts, automation, trigger, envelope_id, source_ids, target_ids, action, result,
    run_id, approved_by
  )
  VALUES (
    NEW.shown_at,
    'production_cancellation_window',
    'customer_portal',
    NULL,
    'job:' || NEW.roof_job_id || ',contract:' || NEW.acceptance_binding_id
      || ',shown_at:' || NEW.shown_at || ',window_ends_at:' || NEW.window_ends_at,
    'contract_signed_copy_event:' || NEW.event_id,
    'shown:signed_copy',
    'ok',
    NEW.event_id,
    NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS contract_signed_copy_events_append_only_update
BEFORE UPDATE ON contract_signed_copy_events
BEGIN
  SELECT RAISE(ABORT, 'contract_signed_copy_event_append_only');
END;

CREATE TRIGGER IF NOT EXISTS contract_signed_copy_events_append_only_delete
BEFORE DELETE ON contract_signed_copy_events
BEGIN
  SELECT RAISE(ABORT, 'contract_signed_copy_event_append_only');
END;

CREATE TRIGGER IF NOT EXISTS contract_signed_copy_served_validate_insert
BEFORE INSERT ON contract_signed_copy_served
BEGIN
  -- REPLACE would delete the confirmation it collides with; a contract's copy is confirmed once.
  SELECT RAISE(ABORT, 'contract_signed_copy_served_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM contract_signed_copy_served existing
     WHERE existing.event_id = NEW.event_id
        OR (existing.tenant_id = NEW.tenant_id
            AND existing.acceptance_binding_id = NEW.acceptance_binding_id)
  );

  -- It confirms that event, of this tenant's contract on this job.
  SELECT RAISE(ABORT, 'contract_signed_copy_served_event_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.event_id = NEW.event_id
       AND shown.tenant_id = NEW.tenant_id
       AND shown.acceptance_binding_id = NEW.acceptance_binding_id
       AND shown.roof_job_id = NEW.roof_job_id
  );

  -- D1 stamps it with its own clock, at its event or within a minute after it: an event left
  -- unconfirmed is never confirmed later, so a copy served later never carries its start.
  SELECT RAISE(ABORT, 'contract_signed_copy_served_at_invalid')
  WHERE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.served_at) IS NOT NEW.served_at
     OR abs(julianday(NEW.served_at) - julianday('now')) * 86400 > 60
     OR EXISTS (
       SELECT 1
         FROM contract_signed_copy_events shown
        WHERE shown.event_id = NEW.event_id
          AND (julianday(NEW.served_at) < julianday(shown.shown_at)
               OR (julianday(NEW.served_at) - julianday(shown.shown_at)) * 86400 > 60)
     );
END;

-- One audit row per confirmation, keyed by `run_id = event_id || ':served'`.
CREATE TRIGGER IF NOT EXISTS contract_signed_copy_served_audit
AFTER INSERT ON contract_signed_copy_served
BEGIN
  INSERT INTO audit_log (
    ts, automation, trigger, envelope_id, source_ids, target_ids, action, result,
    run_id, approved_by
  )
  VALUES (
    NEW.served_at,
    'production_cancellation_window',
    'customer_portal',
    NULL,
    'job:' || NEW.roof_job_id || ',contract:' || NEW.acceptance_binding_id
      || ',event:' || NEW.event_id || ',served_at:' || NEW.served_at,
    'contract_signed_copy_served:' || NEW.event_id,
    'served:signed_copy',
    'ok',
    NEW.event_id || ':served',
    NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS contract_signed_copy_served_append_only_update
BEFORE UPDATE ON contract_signed_copy_served
BEGIN
  SELECT RAISE(ABORT, 'contract_signed_copy_served_append_only');
END;

CREATE TRIGGER IF NOT EXISTS contract_signed_copy_served_append_only_delete
BEFORE DELETE ON contract_signed_copy_served
BEGIN
  SELECT RAISE(ABORT, 'contract_signed_copy_served_append_only');
END;

CREATE TRIGGER IF NOT EXISTS production_cancellation_window_receipts_validate_insert
BEFORE INSERT ON production_cancellation_window_receipts
BEGIN
  -- REPLACE would delete the record or key it collides with before inserting.
  SELECT RAISE(ABORT, 'cancellation_window_receipt_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts existing
     WHERE existing.receipt_id = NEW.receipt_id
        OR (existing.tenant_id = NEW.tenant_id
            AND existing.idempotency_key_hash = NEW.idempotency_key_hash)
  );

  SELECT RAISE(ABORT, 'cancellation_window_receipt_job_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_roof_jobs job
     WHERE job.tenant_id = NEW.tenant_id
       AND job.roof_job_id = NEW.roof_job_id
  );

  -- An active owner or ops person of this tenant, in the role they hold right now; never the QA
  -- seed owner.
  SELECT RAISE(ABORT, 'cancellation_window_receipt_recorder_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users recorder
     WHERE recorder.tenant_id = NEW.tenant_id
       AND recorder.user_id = NEW.recorded_by_user_id
       AND recorder.active = 1
       AND recorder.access_role = NEW.recorded_by_role
       AND recorder.access_role IN ('owner', 'ops')
  );
  SELECT RAISE(ABORT, 'cancellation_window_receipt_seed_identity_refused')
  WHERE EXISTS (
    SELECT 1
      FROM app_users recorder
     WHERE recorder.tenant_id = NEW.tenant_id
       AND recorder.user_id = NEW.recorded_by_user_id
       AND recorder.created_by = 'system:owner_directed_qa_seed_grant'
  );

  -- A reason and an evidence reference, each named when it is missing, and both when both are.
  SELECT RAISE(ABORT, 'cancellation_window_receipt_reason_and_evidence_required')
  WHERE COALESCE(length(trim(NEW.reason)), 0) = 0
    AND COALESCE(length(trim(NEW.evidence_ref)), 0) = 0;
  SELECT RAISE(ABORT, 'cancellation_window_receipt_reason_required')
  WHERE COALESCE(length(trim(NEW.reason)), 0) = 0;
  SELECT RAISE(ABORT, 'cancellation_window_receipt_evidence_required')
  WHERE COALESCE(length(trim(NEW.evidence_ref)), 0) = 0;

  -- A time D1 reads back exactly, and not after D1's now.
  SELECT RAISE(ABORT, 'cancellation_window_receipt_time_invalid')
  WHERE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.received_at) IS NOT NEW.received_at;
  SELECT RAISE(ABORT, 'cancellation_window_receipt_in_future')
  WHERE julianday(NEW.received_at) > julianday('now');

  -- The floor is the job's latest contract, exactly as its binding holds it, or none when the job
  -- has no binding. The latest is the one A2 reads: the latest signature, then the binding id.
  SELECT RAISE(ABORT, 'cancellation_window_receipt_contract_changed')
  WHERE NOT (
    (NEW.acceptance_binding_id IS NULL
      AND NOT EXISTS (
        SELECT 1
          FROM commercial_acceptance_bindings contract
         WHERE contract.tenant_id = NEW.tenant_id
           AND contract.roof_job_id = NEW.roof_job_id
      ))
    OR EXISTS (
      SELECT 1
        FROM commercial_acceptance_bindings contract
       WHERE contract.tenant_id = NEW.tenant_id
         AND contract.roof_job_id = NEW.roof_job_id
         AND contract.acceptance_binding_id = NEW.acceptance_binding_id
         AND contract.accepted_at = NEW.contract_signed_at
         AND NOT EXISTS (
           SELECT 1
             FROM commercial_acceptance_bindings later
            WHERE later.tenant_id = contract.tenant_id
              AND later.roof_job_id = contract.roof_job_id
              AND (later.accepted_at > contract.accepted_at
                   OR (later.accepted_at = contract.accepted_at
                       AND later.acceptance_binding_id > contract.acceptance_binding_id))
         )
    )
  );
  SELECT RAISE(ABORT, 'cancellation_window_receipt_before_contract')
  WHERE NEW.contract_signed_at IS NOT NULL
    AND julianday(NEW.received_at) < julianday(NEW.contract_signed_at);

  -- Later only, against both records: an earlier time would end the window sooner, and the same
  -- time changes nothing.
  SELECT RAISE(ABORT, 'cancellation_window_receipt_earlier_than_recorded')
  WHERE EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts recorded
     WHERE recorded.tenant_id = NEW.tenant_id
       AND recorded.roof_job_id = NEW.roof_job_id
       AND recorded.received_at > NEW.received_at
  )
     OR EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND shown.shown_at > NEW.received_at
  );
  SELECT RAISE(ABORT, 'cancellation_window_receipt_unchanged')
  WHERE EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts recorded
     WHERE recorded.tenant_id = NEW.tenant_id
       AND recorded.roof_job_id = NEW.roof_job_id
       AND recorded.received_at = NEW.received_at
  )
     OR EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND shown.shown_at = NEW.received_at
  );

  -- The same bounds as an event's: [start + 240 hours, start + 266 hours], and no previous end later.
  SELECT RAISE(ABORT, 'cancellation_window_receipt_end_invalid')
  WHERE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.window_ends_at) IS NOT NEW.window_ends_at
     OR NEW.window_ends_at < strftime('%Y-%m-%dT%H:%M:%fZ', NEW.received_at, '+240 hours')
     OR NEW.window_ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', NEW.received_at, '+266 hours')
     OR EXISTS (
       SELECT 1
         FROM production_cancellation_window_receipts recorded
        WHERE recorded.tenant_id = NEW.tenant_id
          AND recorded.roof_job_id = NEW.roof_job_id
          AND recorded.window_ends_at > NEW.window_ends_at
     )
     OR EXISTS (
       SELECT 1
         FROM contract_signed_copy_events shown
        WHERE shown.tenant_id = NEW.tenant_id
          AND shown.roof_job_id = NEW.roof_job_id
          AND shown.window_ends_at > NEW.window_ends_at
     );

  -- D1 stamps when the record was made, from its own clock.
  SELECT RAISE(ABORT, 'cancellation_window_receipt_recorded_at_invalid')
  WHERE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.recorded_at) IS NOT NEW.recorded_at
     OR abs(julianday(NEW.recorded_at) - julianday('now')) * 86400 > 60;
END;

-- One audit row per record, keyed by `run_id = receipt_id`. The reason and the evidence reference
-- stay on the record.
CREATE TRIGGER IF NOT EXISTS production_cancellation_window_receipts_audit
AFTER INSERT ON production_cancellation_window_receipts
BEGIN
  INSERT INTO audit_log (
    ts, automation, trigger, envelope_id, source_ids, target_ids, action, result,
    run_id, approved_by
  )
  VALUES (
    NEW.recorded_at,
    'production_cancellation_window',
    'person',
    NULL,
    'job:' || NEW.roof_job_id || ',contract:' || COALESCE(NEW.acceptance_binding_id, 'none')
      || ',received_at:' || NEW.received_at || ',window_ends_at:' || NEW.window_ends_at,
    'production_cancellation_window_receipt:' || NEW.receipt_id,
    'record:signed_copy_received',
    'ok',
    NEW.receipt_id,
    NEW.recorded_by_user_id
  );
END;

CREATE TRIGGER IF NOT EXISTS production_cancellation_window_receipts_append_only_update
BEFORE UPDATE ON production_cancellation_window_receipts
BEGIN
  SELECT RAISE(ABORT, 'cancellation_window_receipt_append_only');
END;

CREATE TRIGGER IF NOT EXISTS production_cancellation_window_receipts_append_only_delete
BEFORE DELETE ON production_cancellation_window_receipts
BEGIN
  SELECT RAISE(ABORT, 'cancellation_window_receipt_append_only');
END;

-- The firm start. Unknown is checked first: it holds until the copy is shown or a person records
-- when it was received.
CREATE TRIGGER IF NOT EXISTS operating_job_assignments_cancellation_window_hold
BEFORE INSERT ON operating_job_assignments
BEGIN
  SELECT RAISE(ABORT, 'operating_job_assignment_cancellation_window_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = shown.tenant_id
            AND contract.roof_job_id = shown.roof_job_id
            AND julianday(contract.accepted_at) > julianday(shown.contract_signed_at)
       )
  )
    AND NOT EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.roof_job_id = NEW.roof_job_id
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = receipt.tenant_id
            AND contract.roof_job_id = receipt.roof_job_id
            AND julianday(contract.accepted_at) > julianday(receipt.received_at)
       )
  );
  SELECT RAISE(ABORT, 'operating_job_assignment_cancellation_window_open')
  WHERE EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND julianday(shown.window_ends_at) > julianday('now')
  )
     OR EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.roof_job_id = NEW.roof_job_id
       AND julianday(receipt.window_ends_at) > julianday('now')
  );
END;

-- The Materials attestation, and any later `clear` on Materials. A waiver, a reversal and every
-- other gate are not held.
CREATE TRIGGER IF NOT EXISTS production_gate_clearances_cancellation_window_hold
BEFORE INSERT ON production_gate_clearances
WHEN NEW.gate = 'Materials' AND NEW.entry_kind = 'clear'
BEGIN
  SELECT RAISE(ABORT, 'production_gate_cancellation_window_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = shown.tenant_id
            AND contract.roof_job_id = shown.roof_job_id
            AND julianday(contract.accepted_at) > julianday(shown.contract_signed_at)
       )
  )
    AND NOT EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.roof_job_id = NEW.roof_job_id
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = receipt.tenant_id
            AND contract.roof_job_id = receipt.roof_job_id
            AND julianday(contract.accepted_at) > julianday(receipt.received_at)
       )
  );
  SELECT RAISE(ABORT, 'production_gate_cancellation_window_open')
  WHERE EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND julianday(shown.window_ends_at) > julianday('now')
  )
     OR EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.roof_job_id = NEW.roof_job_id
       AND julianday(receipt.window_ends_at) > julianday('now')
  );
END;

-- A purchase order line's job link. Null is a stock line, held by no job's window.
ALTER TABLE inventory_po_lines ADD COLUMN roof_job_id TEXT CHECK (
  roof_job_id IS NULL OR length(roof_job_id) BETWEEN 8 AND 200
);

CREATE TRIGGER IF NOT EXISTS inventory_po_lines_cancellation_window_hold
BEFORE INSERT ON inventory_po_lines
WHEN NEW.roof_job_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'inventory_po_line_job_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_roof_jobs job
     WHERE job.tenant_id = NEW.tenant_id
       AND job.roof_job_id = NEW.roof_job_id
  );
  SELECT RAISE(ABORT, 'inventory_po_line_cancellation_window_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = shown.tenant_id
            AND contract.roof_job_id = shown.roof_job_id
            AND julianday(contract.accepted_at) > julianday(shown.contract_signed_at)
       )
  )
    AND NOT EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.roof_job_id = NEW.roof_job_id
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = receipt.tenant_id
            AND contract.roof_job_id = receipt.roof_job_id
            AND julianday(contract.accepted_at) > julianday(receipt.received_at)
       )
  );
  SELECT RAISE(ABORT, 'inventory_po_line_cancellation_window_open')
  WHERE EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND julianday(shown.window_ends_at) > julianday('now')
  )
     OR EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.roof_job_id = NEW.roof_job_id
       AND julianday(receipt.window_ends_at) > julianday('now')
  );
END;

-- The link never changes once written, and a job's line that left `ordered` (backordered,
-- cancelled) does not move back to `ordered` while the job's window holds. Receiving, cancelling
-- and every other move are not held.
CREATE TRIGGER IF NOT EXISTS inventory_po_lines_cancellation_window_update_hold
BEFORE UPDATE ON inventory_po_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_po_line_job_link_immutable')
  WHERE NEW.roof_job_id IS NOT OLD.roof_job_id;
  SELECT RAISE(ABORT, 'inventory_po_line_cancellation_window_unknown')
  WHERE NEW.roof_job_id IS NOT NULL
    AND NEW.status = 'ordered'
    AND OLD.status IS NOT 'ordered'
    AND NOT EXISTS (
      SELECT 1
        FROM contract_signed_copy_events shown
       WHERE shown.tenant_id = NEW.tenant_id
         AND shown.roof_job_id = NEW.roof_job_id
         AND NOT EXISTS (
           SELECT 1
             FROM commercial_acceptance_bindings contract
            WHERE contract.tenant_id = shown.tenant_id
              AND contract.roof_job_id = shown.roof_job_id
              AND julianday(contract.accepted_at) > julianday(shown.contract_signed_at)
         )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM production_cancellation_window_receipts receipt
       WHERE receipt.tenant_id = NEW.tenant_id
         AND receipt.roof_job_id = NEW.roof_job_id
         AND NOT EXISTS (
           SELECT 1
             FROM commercial_acceptance_bindings contract
            WHERE contract.tenant_id = receipt.tenant_id
              AND contract.roof_job_id = receipt.roof_job_id
              AND julianday(contract.accepted_at) > julianday(receipt.received_at)
         )
    );
  SELECT RAISE(ABORT, 'inventory_po_line_cancellation_window_open')
  WHERE NEW.roof_job_id IS NOT NULL
    AND NEW.status = 'ordered'
    AND OLD.status IS NOT 'ordered'
    AND (
      EXISTS (
        SELECT 1
          FROM contract_signed_copy_events shown
         WHERE shown.tenant_id = NEW.tenant_id
           AND shown.roof_job_id = NEW.roof_job_id
           AND julianday(shown.window_ends_at) > julianday('now')
      )
      OR EXISTS (
        SELECT 1
          FROM production_cancellation_window_receipts receipt
         WHERE receipt.tenant_id = NEW.tenant_id
           AND receipt.roof_job_id = NEW.roof_job_id
           AND julianday(receipt.window_ends_at) > julianday('now')
      )
    );
END;

-- 0098's validate trigger, unchanged. Re-created after the window hold above so that it still fires
-- first: every 0098 refusal answers before the window, and the window before 0159's guard.
DROP TRIGGER operating_job_assignments_validate_insert;

CREATE TRIGGER operating_job_assignments_validate_insert
BEFORE INSERT ON operating_job_assignments
BEGIN
  SELECT RAISE(ABORT, 'operating_job_assignment_job_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_roof_jobs job
     WHERE job.tenant_id = NEW.tenant_id
       AND job.roof_job_id = NEW.roof_job_id
       AND job.version = NEW.roof_job_version
       AND job.job_status NOT IN ('complete', 'cancelled')
  );

  SELECT RAISE(ABORT, 'operating_job_assignment_gates_blocked')
  WHERE (
    SELECT COUNT(*)
      FROM operating_production_gates gate
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate IN ('Deposit', 'Materials', 'Safety', 'Access', 'Weather', 'Crew')
       AND gate.state IN ('ready', 'complete', 'waived')
  ) != 6;

  SELECT RAISE(ABORT, 'operating_job_assignment_crew_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM fleet_crews crew
     WHERE crew.tenant_id = NEW.tenant_id
       AND crew.crew_id = NEW.crew_id
       AND crew.version = NEW.crew_version
       AND crew.status = 'Active'
  );

  SELECT RAISE(ABORT, 'operating_job_assignment_actor_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.actor_user_id
       AND actor.active = 1
       AND actor.access_role IN ('owner', 'ops', 'production')
  );

  SELECT RAISE(ABORT, 'operating_job_assignment_roster_invalid')
  WHERE EXISTS (
    SELECT 1
      FROM json_each(NEW.assigned_users_json) member
     WHERE member.type != 'text'
        OR length(trim(member.value)) NOT BETWEEN 8 AND 200
  )
     OR EXISTS (
       SELECT 1
         FROM json_each(NEW.assigned_users_json) member
        GROUP BY lower(trim(member.value))
       HAVING COUNT(*) > 1
     )
     OR json_array_length(NEW.assigned_users_json) != (
       SELECT COUNT(*)
         FROM fleet_crew_members membership
        WHERE membership.tenant_id = NEW.tenant_id
          AND membership.crew_id = NEW.crew_id
          AND membership.active = 1
     )
     OR EXISTS (
       SELECT 1
         FROM fleet_crew_members membership
         LEFT JOIN app_users worker
           ON worker.tenant_id = membership.tenant_id
          AND worker.user_id = membership.user_id
        WHERE membership.tenant_id = NEW.tenant_id
          AND membership.crew_id = NEW.crew_id
          AND membership.active = 1
          AND (
            worker.user_id IS NULL
            OR worker.active != 1
            OR worker.access_role != 'field'
            OR NOT EXISTS (
              SELECT 1
                FROM json_each(NEW.assigned_users_json) member
               WHERE member.value = membership.user_id
            )
          )
     );

  SELECT RAISE(ABORT, 'operating_job_assignment_chain_conflict')
  WHERE (
    NEW.supersedes_assignment_id IS NULL
    AND EXISTS (
      SELECT 1
        FROM operating_job_assignments current
       WHERE current.tenant_id = NEW.tenant_id
         AND current.roof_job_id = NEW.roof_job_id
         AND NOT EXISTS (
           SELECT 1
             FROM operating_job_assignments successor
            WHERE successor.tenant_id = current.tenant_id
              AND successor.supersedes_assignment_id = current.assignment_id
         )
    )
  ) OR (
    NEW.supersedes_assignment_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM operating_job_assignments current
       WHERE current.tenant_id = NEW.tenant_id
         AND current.roof_job_id = NEW.roof_job_id
         AND current.assignment_id = NEW.supersedes_assignment_id
         AND current.assignment_version + 1 = NEW.assignment_version
         AND NOT EXISTS (
           SELECT 1
             FROM operating_job_assignments successor
            WHERE successor.tenant_id = current.tenant_id
              AND successor.supersedes_assignment_id = current.assignment_id
         )
    )
  );
END;

-- 0153's replace guard, unchanged. Re-created after the Materials hold so that it still fires first.
DROP TRIGGER production_gate_clearances_no_insert_replace;

CREATE TRIGGER production_gate_clearances_no_insert_replace
BEFORE INSERT ON production_gate_clearances
BEGIN
  SELECT RAISE(ABORT, 'production_gate_clearance_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM production_gate_clearances existing
     WHERE existing.clearance_id = NEW.clearance_id
        OR (existing.tenant_id = NEW.tenant_id
            AND existing.idempotency_key_hash = NEW.idempotency_key_hash)
  );
  SELECT RAISE(ABORT, 'production_gate_version_conflict')
  WHERE EXISTS (
    SELECT 1
      FROM production_gate_clearances existing
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.gate_id = NEW.gate_id
       AND existing.from_gate_version = NEW.from_gate_version
  );
END;
