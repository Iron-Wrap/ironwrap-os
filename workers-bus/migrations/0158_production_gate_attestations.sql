-- 0158_production_gate_attestations.sql - a person attests a gate with evidence, or reverses one.
--
-- 0153 admitted settlement and waiver entries only. This migration re-creates the ledger's validate
-- trigger under its name with every 0153 rule kept for the entries 0153 admits, including at most
-- one open waiver request per gate per person and no contract facts on any entry. Only 0153's
-- refusal of any `reverses_id` and of any `attestation_json`, and its blocked-gate rule, now
-- make room for the two person entries the matrix gains:
--   * `clear` / `person_attestation`: Materials, Safety, Access or Weather, to `ready`, by an active
--     owner or production user who is not an active member of any crew under any login coordinate
--     they carry (user id, email or Frappe user). Each gate has one small typed shape in
--     `attestation_json`; the only free text is an optional note of at most 300 characters, kept in
--     the redactable `reason`. `evidence_refs_json` lists 0 to 10 references the Worker resolved
--     and checksummed: a verified, stored Work Package capture of the job or, on Materials only, a
--     live stock reservation of the job at its current version.
--       - Materials is refused while an inventory exception of the job is open or contained.
--       - Safety is the `production.gates.safety` set ("checks site safety"), carried today by owner
--         and production. It names the attester's current internal Worker Competency, verified, in
--         force today and not bound to another job, and it is refused during an active safety stop
--         on the job. Only a person ever clears Safety, and it is never waived.
--       - Weather names a work window of at most 14 days that has not ended and ends within 14 days
--         of the forecast it rests on, which was observed at most 72 hours ago.
--   * `reverse` / `person_reversal`: by an owner or production user, with a reason, of the entry
--     that holds the gate's current state. The gate returns to `blocked` and nothing is deleted. A
--     `contract_no_deposit` entry is reversed only by a superseding contract, never by a person.
-- Every time rule reads D1's own clock, never the entry's `created_at`. 0153's replace guard is then
-- re-created unchanged so that, firing newest first, a replayed key still reports itself before
-- validation. Object counts are unchanged.

DROP TRIGGER production_gate_clearances_validate_insert;

CREATE TRIGGER production_gate_clearances_validate_insert
BEFORE INSERT ON production_gate_clearances
BEGIN
  -- Legacy entries come only from the 0153 backfill.
  SELECT RAISE(ABORT, 'production_gate_clearance_legacy_closed')
  WHERE NEW.entry_kind = 'legacy';

  -- The entry names this tenant's gate as it stands now.
  SELECT RAISE(ABORT, 'production_gate_clearance_gate_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.gate_id = NEW.gate_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate = NEW.gate
  );
  SELECT RAISE(ABORT, 'production_gate_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.gate_id = NEW.gate_id
       AND gate.version = NEW.from_gate_version
  );

  -- Safety and Weather are never waivable, and Crew has no waiver.
  SELECT RAISE(ABORT, 'production_gate_not_waivable')
  WHERE NEW.basis = 'office_waiver' AND NEW.gate NOT IN ('Deposit', 'Materials', 'Access');

  -- Only a person clears Safety: no agent and no policy ever attests it.
  SELECT RAISE(ABORT, 'production_gate_safety_person_only')
  WHERE NEW.gate = 'Safety' AND NEW.entry_kind = 'clear' AND NEW.actor_kind IS NOT 'person';

  -- The basis x gate matrix this ledger admits, all of it person entries.
  SELECT RAISE(ABORT, 'production_gate_clearance_basis_invalid')
  WHERE NOT (
      (NEW.entry_kind = 'clear' AND NEW.basis = 'deposit_settlement'
        AND NEW.gate = 'Deposit' AND NEW.to_state = 'complete'
        AND NEW.request_id IS NULL AND NEW.requested_by IS NULL)
      OR (NEW.entry_kind = 'clear' AND NEW.basis = 'person_attestation'
        AND NEW.gate IN ('Materials', 'Safety', 'Access', 'Weather') AND NEW.to_state = 'ready'
        AND NEW.request_id IS NULL AND NEW.requested_by IS NULL)
      OR (NEW.entry_kind = 'waiver_request' AND NEW.basis = 'office_waiver'
        AND NEW.to_state = 'blocked'
        AND NEW.request_id IS NULL AND NEW.requested_by IS NULL)
      OR (NEW.entry_kind = 'waiver_decision' AND NEW.basis = 'office_waiver'
        AND NEW.to_state IN ('waived', 'blocked') AND NEW.requested_by IS NOT NULL)
      OR (NEW.entry_kind = 'reverse' AND NEW.basis = 'person_reversal'
        AND NEW.to_state = 'blocked' AND NEW.reverses_id IS NOT NULL
        AND NEW.request_id IS NULL AND NEW.requested_by IS NULL)
    )
    OR NEW.actor_kind IS NOT 'person'
    OR NEW.actor_user_id IS NULL
    OR (NEW.reverses_id IS NOT NULL AND NEW.entry_kind != 'reverse')
    OR NEW.reason_redacted_at IS NOT NULL
    OR (NEW.self_approval = 1 AND NEW.actor_user_id IS NOT NEW.requested_by)
    -- No entry admitted here carries contract facts, only an attestation carries a structured
    -- attestation, and neither a waiver nor a reversal carries structured evidence of its own.
    OR (NEW.attestation_json IS NOT NULL AND NEW.basis != 'person_attestation')
    OR NEW.policy_version IS NOT NULL
    OR NEW.terms_hash IS NOT NULL
    OR NEW.contract_binding_id IS NOT NULL
    OR (NEW.entry_kind IN ('waiver_request', 'waiver_decision', 'reverse')
        AND NEW.evidence_refs_json IS NOT NULL);

  -- A clear, a waiver request or a waiver decision acts on a blocked gate, and a reversal on a gate
  -- that is not blocked.
  SELECT RAISE(ABORT, 'production_gate_already_cleared')
  WHERE NEW.entry_kind != 'reverse'
    AND NOT EXISTS (
      SELECT 1
        FROM operating_production_gates gate
       WHERE gate.tenant_id = NEW.tenant_id
         AND gate.gate_id = NEW.gate_id
         AND gate.state = 'blocked'
    );
  SELECT RAISE(ABORT, 'production_gate_not_cleared')
  WHERE NEW.entry_kind = 'reverse'
    AND NOT EXISTS (
      SELECT 1
        FROM operating_production_gates gate
       WHERE gate.tenant_id = NEW.tenant_id
         AND gate.gate_id = NEW.gate_id
         AND gate.state != 'blocked'
    );

  -- A person entry: an active user of this tenant holding the recorded role right now.
  SELECT RAISE(ABORT, 'production_gate_clearance_actor_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.actor_user_id
       AND actor.active = 1
       AND actor.access_role = NEW.actor_role
  );
  SELECT RAISE(ABORT, 'production_gate_clearance_seed_identity_refused')
  WHERE EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.actor_user_id
       AND actor.created_by = 'system:owner_directed_qa_seed_grant'
  );

  -- `production.gates.clear` (owner, production) clears on settlement, attests, requests a waiver
  -- and reverses. `production.gates.safety` ("checks site safety") attests Safety and is carried
  -- today by the same two roles. The decider holds the matching set: `money.approve` for Deposit,
  -- `production.gates.waive` for Materials and Access. Today the owner carries both.
  SELECT RAISE(ABORT, 'production_gate_clearance_actor_invalid')
  WHERE (NEW.entry_kind IN ('clear', 'waiver_request', 'reverse')
         AND NEW.actor_role NOT IN ('owner', 'production'))
     OR (NEW.basis = 'person_attestation' AND NEW.gate = 'Safety'
         AND NEW.actor_role NOT IN ('owner', 'production'))
     OR (NEW.entry_kind = 'waiver_decision' AND NEW.actor_role != 'owner');

  SELECT RAISE(ABORT, 'production_gate_clearance_reason_required')
  WHERE NEW.entry_kind IN ('waiver_request', 'waiver_decision', 'reverse')
    AND (NEW.reason IS NULL OR length(trim(NEW.reason)) = 0);

  -- One open waiver request per gate per person: a second would only move the gate's version
  -- under the owner deciding the first.
  SELECT RAISE(ABORT, 'production_gate_waiver_request_open')
  WHERE NEW.entry_kind = 'waiver_request'
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances request
       WHERE request.tenant_id = NEW.tenant_id
         AND request.gate_id = NEW.gate_id
         AND request.entry_kind = 'waiver_request'
         AND request.actor_user_id = NEW.actor_user_id
         AND NOT EXISTS (
           SELECT 1
             FROM production_gate_clearances decision
            WHERE decision.tenant_id = request.tenant_id
              AND decision.request_id = request.clearance_id
         )
    );

  -- An attester is on no crew: no active crew membership names a login that shares the attester's
  -- user id, email or Frappe user.
  SELECT RAISE(ABORT, 'production_gate_attester_on_crew')
  WHERE NEW.basis = 'person_attestation'
    AND EXISTS (
      SELECT 1
        FROM app_users attester
        JOIN fleet_crew_members membership
          ON membership.tenant_id = attester.tenant_id
         AND membership.active = 1
        JOIN app_users worker
          ON worker.tenant_id = membership.tenant_id
         AND worker.user_id = membership.user_id
       WHERE attester.tenant_id = NEW.tenant_id
         AND attester.user_id = NEW.actor_user_id
         AND (
           lower(worker.user_id) IN (
             lower(attester.user_id), attester.email_normalized, lower(trim(attester.frappe_user_id))
           )
           OR worker.email_normalized IN (
             lower(attester.user_id), attester.email_normalized, lower(trim(attester.frappe_user_id))
           )
           OR lower(trim(worker.frappe_user_id)) IN (
             lower(attester.user_id), attester.email_normalized, lower(trim(attester.frappe_user_id))
           )
         )
    );

  -- One small typed shape per gate and no free text but a note of at most 300 characters.
  -- References are short identifiers, never prose. Times are UTC instants as the Worker writes
  -- them, and a time something was observed, confirmed or assessed is never in the future.
  SELECT RAISE(ABORT, 'production_gate_attestation_invalid')
  WHERE NEW.basis = 'person_attestation'
    AND (
      (NEW.reason IS NOT NULL AND length(NEW.reason) > 300)
      OR json_type(NEW.attestation_json) IS NOT 'object'
      OR EXISTS (
        SELECT 1
          FROM json_each(NEW.attestation_json) field
         WHERE NOT (
           (NEW.gate = 'Materials' AND field.key IN ('source', 'reference'))
           OR (NEW.gate = 'Access'
               AND field.key IN ('confirmed_with', 'confirmed_at', 'constraints'))
           OR (NEW.gate = 'Weather' AND field.key IN (
               'window_start', 'window_end', 'forecast_source', 'forecast_observed_at'))
           OR (NEW.gate = 'Safety' AND field.key IN (
               'hazard_assessment_ref', 'fall_protection', 'assessed_at', 'competency'))
         )
      )
      OR EXISTS (
        SELECT 1
          FROM json_each(NEW.attestation_json) field
         WHERE field.key IN (
             'confirmed_at', 'window_start', 'window_end', 'forecast_observed_at', 'assessed_at'
           )
           AND (
             field.type IS NOT 'text'
             OR field.value NOT GLOB
               '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
             OR strftime('%Y-%m-%dT%H:%M:%fZ', field.value) IS NOT field.value
             OR (field.key NOT IN ('window_start', 'window_end')
                 AND julianday(field.value) > julianday('now', '+5 minutes'))
           )
      )
      OR EXISTS (
        SELECT 1
          FROM json_each(NEW.attestation_json) field
         WHERE field.key IN ('reference', 'hazard_assessment_ref')
           AND (
             field.type IS NOT 'text'
             OR length(field.value) NOT BETWEEN 1 AND 80
             OR field.value NOT GLOB '[A-Za-z0-9]*'
             OR field.value GLOB '*[^A-Za-z0-9._:/#-]*'
           )
      )
      OR (NEW.gate = 'Materials' AND (
        json_type(NEW.attestation_json, '$.source') IS NOT 'text'
        OR json_extract(NEW.attestation_json, '$.source') NOT IN (
          'supplier_delivery', 'reserved_stock', 'customer_supplied', 'none_needed'
        )
        OR json_type(NEW.attestation_json, '$.reference') IS NOT 'text'
      ))
      OR (NEW.gate = 'Access' AND (
        json_type(NEW.attestation_json, '$.confirmed_with') IS NOT 'text'
        OR json_extract(NEW.attestation_json, '$.confirmed_with') NOT IN (
          'customer', 'property_manager', 'not_needed'
        )
        OR json_type(NEW.attestation_json, '$.confirmed_at') IS NOT 'text'
        OR (json_type(NEW.attestation_json, '$.constraints') IS NOT NULL AND (
          json_type(NEW.attestation_json, '$.constraints') IS NOT 'array'
          OR json_array_length(NEW.attestation_json, '$.constraints') NOT BETWEEN 1 AND 16
          OR (
            SELECT COUNT(DISTINCT item.value)
              FROM json_each(NEW.attestation_json, '$.constraints') item
          ) != json_array_length(NEW.attestation_json, '$.constraints')
          OR EXISTS (
            SELECT 1
              FROM json_each(NEW.attestation_json, '$.constraints') item
             WHERE item.type IS NOT 'text'
                OR item.value NOT IN (
                  'occupants', 'tenants', 'pets', 'parking', 'neighbours', 'utilities',
                  'overhead_lines', 'roof_access', 'bin_placement', 'road_occupancy',
                  'washroom', 'storage', 'delivery', 'valuables', 'landscape',
                  'interior_protection'
                )
          )
        ))
      ))
      OR (NEW.gate = 'Weather' AND (
        json_type(NEW.attestation_json, '$.window_start') IS NOT 'text'
        OR json_type(NEW.attestation_json, '$.window_end') IS NOT 'text'
        OR json_type(NEW.attestation_json, '$.forecast_observed_at') IS NOT 'text'
        OR json_type(NEW.attestation_json, '$.forecast_source') IS NOT 'text'
        OR length(json_extract(NEW.attestation_json, '$.forecast_source')) NOT BETWEEN 2 AND 64
        OR json_extract(NEW.attestation_json, '$.forecast_source') NOT GLOB '[a-z0-9]*'
        OR json_extract(NEW.attestation_json, '$.forecast_source') GLOB '*[^a-z0-9.-]*'
      ))
      OR (NEW.gate = 'Safety' AND (
        json_type(NEW.attestation_json, '$.hazard_assessment_ref') IS NOT 'text'
        OR json_type(NEW.attestation_json, '$.assessed_at') IS NOT 'text'
        OR json_type(NEW.attestation_json, '$.fall_protection') IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.attestation_json, '$.fall_protection')) != 1
        OR NOT (
          json_type(NEW.attestation_json, '$.fall_protection.no_exposure_at_3m') IS 'true'
          OR (
            json_type(NEW.attestation_json, '$.fall_protection.plan_ref') IS 'text'
            AND length(json_extract(NEW.attestation_json, '$.fall_protection.plan_ref'))
              BETWEEN 1 AND 80
            AND json_extract(NEW.attestation_json, '$.fall_protection.plan_ref')
              GLOB '[A-Za-z0-9]*'
            AND json_extract(NEW.attestation_json, '$.fall_protection.plan_ref')
              NOT GLOB '*[^A-Za-z0-9._:/#-]*'
          )
        )
        OR json_type(NEW.attestation_json, '$.competency') IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(NEW.attestation_json, '$.competency')) != 4
        OR json_type(NEW.attestation_json, '$.competency.readback_id') IS NOT 'text'
        OR json_type(NEW.attestation_json, '$.competency.authority_record_id') IS NOT 'text'
        OR json_type(NEW.attestation_json, '$.competency.authority_version') IS NOT 'integer'
        OR json_type(NEW.attestation_json, '$.competency.state_digest_sha256') IS NOT 'text'
      ))
    );

  -- 0 to 10 distinct references, each resolved by the Worker against this job: exactly one
  -- verified, manifested, stored Work Package capture with the checksum of the stored object or,
  -- on Materials, a live stock reservation of this job at its current version with the digest the
  -- Worker took of it.
  SELECT RAISE(ABORT, 'production_gate_evidence_invalid')
  WHERE NEW.basis = 'person_attestation'
    AND (
      json_type(NEW.evidence_refs_json) IS NOT 'array'
      OR json_array_length(NEW.evidence_refs_json) > 10
      OR (
        SELECT COUNT(DISTINCT json_extract(NEW.evidence_refs_json, item.fullkey || '.ref'))
          FROM json_each(NEW.evidence_refs_json) item
      ) != json_array_length(NEW.evidence_refs_json)
      OR EXISTS (
        SELECT 1
          FROM json_each(NEW.evidence_refs_json) item
         WHERE item.type IS NOT 'object'
            OR json_type(NEW.evidence_refs_json, item.fullkey || '.ref') IS NOT 'text'
            OR json_type(NEW.evidence_refs_json, item.fullkey || '.sha256') IS NOT 'text'
            OR NOT (
              (
                (SELECT COUNT(*) FROM json_each(NEW.evidence_refs_json, item.fullkey)) = 2
                AND (
                  SELECT COUNT(*)
                    FROM field_actions capture
                    JOIN field_action_media media
                      ON media.device_action_id = capture.device_action_id
                   WHERE capture.tenant_id = NEW.tenant_id
                     AND capture.job_id = NEW.roof_job_id
                     AND capture.work_package_id IS NOT NULL
                     AND capture.status = 'verified'
                     AND capture.manifest_key IS NOT NULL
                     AND capture.evidence_verification = 'Verified'
                     AND media.r2_stored_at IS NOT NULL
                     AND 'field-evidence://' || media.evidence_id
                       = json_extract(NEW.evidence_refs_json, item.fullkey || '.ref')
                     AND media.checksum_sha256
                       = json_extract(NEW.evidence_refs_json, item.fullkey || '.sha256')
                ) = 1
              )
              OR (
                NEW.gate = 'Materials'
                AND (SELECT COUNT(*) FROM json_each(NEW.evidence_refs_json, item.fullkey)) = 3
                AND json_type(NEW.evidence_refs_json, item.fullkey || '.version') IS 'integer'
                AND length(json_extract(NEW.evidence_refs_json, item.fullkey || '.sha256')) = 64
                AND json_extract(NEW.evidence_refs_json, item.fullkey || '.sha256')
                  NOT GLOB '*[^0-9a-f]*'
                AND EXISTS (
                  SELECT 1
                    FROM inventory_reservations reservation
                   WHERE reservation.tenant_id = NEW.tenant_id
                     AND reservation.job_id = NEW.roof_job_id
                     AND 'stock-reservation://' || reservation.reservation_id
                       = json_extract(NEW.evidence_refs_json, item.fullkey || '.ref')
                     AND reservation.version
                       = json_extract(NEW.evidence_refs_json, item.fullkey || '.version')
                     AND reservation.status IN ('reserved', 'partially_issued', 'issued')
                )
              )
            )
      )
    );

  -- Materials is never attested over an inventory exception of the job that is open or contained,
  -- read as the production runway reads it.
  SELECT RAISE(ABORT, 'production_gate_material_exception_open')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Materials'
    AND EXISTS (
      SELECT 1
        FROM inventory_exceptions held
       WHERE held.tenant_id = NEW.tenant_id
         AND held.aggregate_type = 'roof_job'
         AND held.aggregate_id = NEW.roof_job_id
         AND held.status IN ('open', 'contained')
    );

  -- Safety is never attested during an active safety stop on the job, read as the job phase reads it.
  SELECT RAISE(ABORT, 'production_gate_safety_stop_active')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Safety'
    AND EXISTS (
      SELECT 1
        FROM safety_occurrences occurrence
       WHERE occurrence.tenant_id = NEW.tenant_id
         AND occurrence.scope_type = 'roof_job'
         AND occurrence.scope_id = NEW.roof_job_id
         AND occurrence.stop_active = 1
    );

  -- Safety names the attester's current internal Worker Competency: the latest version of its
  -- record, with no contradicting copy of that version, superseded by no other record, verified by
  -- an internal assessment, not revoked, in force today and not bound to another job. Its person is
  -- any login coordinate the attester carries.
  SELECT RAISE(ABORT, 'production_gate_competency_required')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Safety'
    AND NOT EXISTS (
      SELECT 1
        FROM authority_record_readbacks competency
        JOIN app_users attester
          ON attester.tenant_id = competency.tenant_id
         AND attester.user_id = NEW.actor_user_id
       WHERE competency.tenant_id = NEW.tenant_id
         AND competency.readback_id
           = json_extract(NEW.attestation_json, '$.competency.readback_id')
         AND competency.authority_record_id
           = json_extract(NEW.attestation_json, '$.competency.authority_record_id')
         AND competency.authority_version
           = json_extract(NEW.attestation_json, '$.competency.authority_version')
         AND competency.authority_state_digest_sha256
           = json_extract(NEW.attestation_json, '$.competency.state_digest_sha256')
         AND competency.subject_type = 'Person'
         AND competency.subject_role = 'Worker'
         AND competency.authority_kind = 'Worker Competency'
         AND lower(trim(competency.person_user)) IN (
           lower(attester.user_id), attester.email_normalized, lower(trim(attester.frappe_user_id))
         )
         AND (competency.roof_job IS NULL OR competency.roof_job = NEW.roof_job_id)
         AND competency.verification_state = 'verified'
         AND competency.authority_revoked_at IS NULL
         AND competency.authority_verification_method = 'Internal Competency Assessment'
         AND competency.authority_effective_from IS NOT NULL
         AND competency.authority_expires_at IS NOT NULL
         AND competency.authority_effective_from <= date('now')
         AND competency.authority_expires_at >= date('now')
         AND NOT EXISTS (
           SELECT 1
             FROM authority_record_readbacks other
            WHERE other.tenant_id = competency.tenant_id
              AND other.authority_record_id = competency.authority_record_id
              AND (
                other.authority_version > competency.authority_version
                OR (other.authority_version = competency.authority_version
                    AND other.authority_state_digest_sha256
                      != competency.authority_state_digest_sha256)
              )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM authority_record_readbacks successor
            WHERE successor.tenant_id = competency.tenant_id
              AND successor.supersedes_authority_record_id = competency.authority_record_id
         )
    );

  -- Weather rests on a forecast observed at most 72 hours ago, for a window of at most 14 days that
  -- has not ended and ends within 14 days of that forecast.
  SELECT RAISE(ABORT, 'production_gate_forecast_stale')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Weather'
    AND julianday(json_extract(NEW.attestation_json, '$.forecast_observed_at'))
      < julianday('now', '-72 hours');
  SELECT RAISE(ABORT, 'production_gate_weather_window_invalid')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Weather'
    AND (
      julianday(json_extract(NEW.attestation_json, '$.window_end'))
        <= julianday(json_extract(NEW.attestation_json, '$.window_start'))
      OR julianday(json_extract(NEW.attestation_json, '$.window_end'))
        - julianday(json_extract(NEW.attestation_json, '$.window_start')) > 14
      OR julianday(json_extract(NEW.attestation_json, '$.window_end')) <= julianday('now')
      OR julianday(json_extract(NEW.attestation_json, '$.window_end'))
        > julianday(json_extract(NEW.attestation_json, '$.forecast_observed_at')) + 14
    );

  -- A reversal names the entry that holds the gate's current state: the one its current version
  -- was produced by.
  SELECT RAISE(ABORT, 'production_gate_reversal_target_invalid')
  WHERE NEW.entry_kind = 'reverse'
    AND NOT EXISTS (
      SELECT 1
        FROM production_gate_clearances target
        JOIN operating_production_gates gate
          ON gate.tenant_id = target.tenant_id
         AND gate.gate_id = target.gate_id
       WHERE target.tenant_id = NEW.tenant_id
         AND target.clearance_id = NEW.reverses_id
         AND target.gate_id = NEW.gate_id
         AND target.from_gate_version + 1 = gate.version
         AND target.to_state = gate.state
    );
  -- A contract that needs no deposit is reversed by a superseding contract, never by a person.
  SELECT RAISE(ABORT, 'production_gate_not_reversible')
  WHERE NEW.entry_kind = 'reverse'
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances target
       WHERE target.tenant_id = NEW.tenant_id
         AND target.clearance_id = NEW.reverses_id
         AND target.basis = 'contract_no_deposit'
    );

  -- A settlement is made of a reconciled deposit invoice of this job, named in the evidence.
  SELECT RAISE(ABORT, 'deposit_settlement_not_observed')
  WHERE NEW.basis = 'deposit_settlement'
    AND NOT EXISTS (
      SELECT 1
        FROM accounting_intents intent
       WHERE intent.tenant_id = NEW.tenant_id
         AND intent.roof_job_id = NEW.roof_job_id
         AND intent.kind = 'deposit_invoice'
         AND intent.state = 'reconciled'
         AND intent.settled_amount IS NOT NULL
         AND CAST(replace(intent.settled_amount, '.', '') AS INTEGER) > 0
         AND intent.intent_id = CASE
           WHEN json_valid(NEW.evidence_refs_json)
             THEN json_extract(NEW.evidence_refs_json, '$.money_intent_id')
         END
    );

  -- A decision answers a request for the same gate, made by `requested_by`, at most once.
  SELECT RAISE(ABORT, 'production_gate_waiver_request_invalid')
  WHERE NEW.entry_kind = 'waiver_decision'
    AND NEW.request_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM production_gate_clearances request
       WHERE request.tenant_id = NEW.tenant_id
         AND request.clearance_id = NEW.request_id
         AND request.gate_id = NEW.gate_id
         AND request.entry_kind = 'waiver_request'
         AND request.actor_user_id = NEW.requested_by
    );
  SELECT RAISE(ABORT, 'production_gate_waiver_already_decided')
  WHERE NEW.entry_kind = 'waiver_decision'
    AND NEW.request_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances decision
       WHERE decision.tenant_id = NEW.tenant_id
         AND decision.request_id = NEW.request_id
    );
  -- With no request, a decision is the requester deciding their own item.
  SELECT RAISE(ABORT, 'production_gate_waiver_request_invalid')
  WHERE NEW.entry_kind = 'waiver_decision'
    AND NEW.request_id IS NULL
    AND NEW.requested_by IS NOT NEW.actor_user_id;

  -- Requester != decider, except the only active holder of the set approving their own item
  -- (D-08). The QA seed owner never decides, so it is not counted as a holder.
  SELECT RAISE(ABORT, 'production_gate_waiver_self_approval_refused')
  WHERE NEW.entry_kind = 'waiver_decision'
    AND NEW.actor_user_id = NEW.requested_by
    AND (
      NEW.self_approval != 1
      OR NEW.to_state != 'waived'
      OR EXISTS (
        SELECT 1
          FROM app_users holder
         WHERE holder.tenant_id = NEW.tenant_id
           AND holder.user_id != NEW.actor_user_id
           AND holder.active = 1
           AND holder.access_role = 'owner'
           AND holder.created_by != 'system:owner_directed_qa_seed_grant'
      )
    );
END;

-- 0153's replace guard, unchanged. Re-created last so that it still fires first.
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
