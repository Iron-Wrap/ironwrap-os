-- 0170_safety_stop_route_gaps.sql - an active safety stop holds work on every job it names, for
-- every crew, and on every job of the tenant when the job or Work Package it names doesn't exist.
--
-- Before this migration D1 never consulted a safety stop when a crew acknowledged, started or
-- completed a Work Package: only the Worker's readiness gate did, and it matched a stop's exact
-- scope. A stop on a job or Work Package this tenant does not have held nothing, and a stop on one
-- Work Package of a job held none of that job's other packages. The Worker now applies A3's
-- Safety-gate predicate (0158) and this guard repeats it for any write, not only the Worker's:
--
-- - a `tenant` stop holds every job, whatever its `scope_id`;
-- - a `roof_job` stop holds its job, and every job when `operating_roof_jobs` has no such job;
-- - a `work_package` stop holds the job of every version of that package, Superseded included,
--   and every job when `work_packages` has no such package.
-- An unresolved scope is latched in immutable history. Creating its missing job/package never
-- narrows the hold; only the existing authorized person release lifts it. Backfill currently
-- unresolved active stops on upgrade. A job insert also latches an unresolved stop before the
-- lookup changes, covering a job that was removed and later restored. Work Packages already
-- prohibit deletion and scope changes. No re-scope authority or route is added here.
--
-- Only an active stop holds (`stop_active = 1`). Shop and vehicle stops hold no job. Stopping work
-- (`stop_work`) is never refused, and nor is any capture: a person may always stop work, and the
-- photos that release a stop are taken while it holds the job.
--
-- Office made-safe (P33): any person may say an area is made safe, but a record made away from the
-- site stands only on a named on-site confirmer. A `make_safe` event whose actor is not a field
-- worker names that confirmer (`confirmed_by_user_id`): an active user of this tenant who shares no
-- identity with the recorder (user id, email or Frappe user, compared both ways as 0165 compares a
-- releaser). No other event names one. An occurrence moves `reported -> made_safe` only with that
-- version's own `make_safe` event already written, so the rule holds for any write.
--
-- Keep the stop (P33): a person who may release a stop and decides not to records that decision,
-- with a reason, in `safety_stop_keep_decisions`. It changes nothing on the occurrence. The record
-- is append-only, names the version the person saw (still current, the stop still active), and
-- takes its time from D1's clock. Its keeper holds owner, ops or production at that moment and
-- shares no identity with the raiser.
--
-- Adds one column, two tables, one index and fourteen triggers.

CREATE TABLE safety_stop_unresolved_scopes (
  occurrence_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  latched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (occurrence_id, tenant_id)
    REFERENCES safety_occurrences(occurrence_id, tenant_id) ON DELETE RESTRICT
);

CREATE TRIGGER safety_stop_unresolved_scopes_validate_insert
BEFORE INSERT ON safety_stop_unresolved_scopes
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_scope_not_unresolved')
  WHERE NOT EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.occurrence_id = NEW.occurrence_id
       AND occurrence.tenant_id = NEW.tenant_id
       AND occurrence.stop_active = 1
       AND (
         (occurrence.scope_type = 'roof_job' AND NOT EXISTS (
           SELECT 1 FROM operating_roof_jobs job
            WHERE job.tenant_id = occurrence.tenant_id AND job.roof_job_id = occurrence.scope_id
         ))
         OR (occurrence.scope_type = 'work_package' AND NOT EXISTS (
           SELECT 1 FROM work_packages package
            WHERE package.tenant_id = occurrence.tenant_id AND package.work_package_id = occurrence.scope_id
         ))
       )
  );
END;

CREATE TRIGGER safety_stop_unresolved_scopes_no_replace
BEFORE INSERT ON safety_stop_unresolved_scopes
WHEN EXISTS (SELECT 1 FROM safety_stop_unresolved_scopes WHERE occurrence_id = NEW.occurrence_id)
BEGIN SELECT RAISE(ABORT, 'safety_stop_unresolved_scope_immutable'); END;

CREATE TRIGGER safety_stop_unresolved_scopes_no_update
BEFORE UPDATE ON safety_stop_unresolved_scopes
BEGIN SELECT RAISE(ABORT, 'safety_stop_unresolved_scope_immutable'); END;

CREATE TRIGGER safety_stop_unresolved_scopes_no_delete
BEFORE DELETE ON safety_stop_unresolved_scopes
BEGIN SELECT RAISE(ABORT, 'safety_stop_unresolved_scope_immutable'); END;

INSERT INTO safety_stop_unresolved_scopes (occurrence_id, tenant_id)
SELECT occurrence.occurrence_id, occurrence.tenant_id FROM safety_occurrences occurrence
 WHERE occurrence.stop_active = 1
   AND (
     (occurrence.scope_type = 'roof_job' AND NOT EXISTS (
       SELECT 1 FROM operating_roof_jobs job
        WHERE job.tenant_id = occurrence.tenant_id AND job.roof_job_id = occurrence.scope_id
     ))
     OR (occurrence.scope_type = 'work_package' AND NOT EXISTS (
       SELECT 1 FROM work_packages package
        WHERE package.tenant_id = occurrence.tenant_id AND package.work_package_id = occurrence.scope_id
     ))
   );

CREATE TRIGGER safety_occurrences_latch_unresolved_scope
AFTER INSERT ON safety_occurrences
WHEN NEW.stop_active = 1 AND (
  (NEW.scope_type = 'roof_job' AND NOT EXISTS (
    SELECT 1 FROM operating_roof_jobs WHERE tenant_id = NEW.tenant_id AND roof_job_id = NEW.scope_id
  ))
  OR (NEW.scope_type = 'work_package' AND NOT EXISTS (
    SELECT 1 FROM work_packages WHERE tenant_id = NEW.tenant_id AND work_package_id = NEW.scope_id
  ))
)
BEGIN
  INSERT INTO safety_stop_unresolved_scopes (occurrence_id, tenant_id)
  SELECT NEW.occurrence_id, NEW.tenant_id
   WHERE NOT EXISTS (SELECT 1 FROM safety_stop_unresolved_scopes WHERE occurrence_id = NEW.occurrence_id);
END;

CREATE TRIGGER operating_roof_jobs_latch_unresolved_stops
BEFORE INSERT ON operating_roof_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM operating_roof_jobs WHERE tenant_id = NEW.tenant_id AND roof_job_id = NEW.roof_job_id
)
BEGIN
  INSERT INTO safety_stop_unresolved_scopes (occurrence_id, tenant_id)
  SELECT occurrence.occurrence_id, occurrence.tenant_id FROM safety_occurrences occurrence
   WHERE occurrence.tenant_id = NEW.tenant_id AND occurrence.stop_active = 1
     AND occurrence.scope_type = 'roof_job' AND occurrence.scope_id = NEW.roof_job_id
     AND NOT EXISTS (
       SELECT 1 FROM safety_stop_unresolved_scopes latch WHERE latch.occurrence_id = occurrence.occurrence_id
     );
END;

CREATE TRIGGER work_package_events_safety_stop_guard
BEFORE INSERT ON work_package_events
WHEN NEW.event_kind IN ('acknowledged', 'start_work', 'complete_work')
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_active')
  WHERE EXISTS (
    SELECT 1
      FROM safety_occurrences occurrence
      JOIN work_packages current
        ON current.tenant_id = NEW.tenant_id
       AND current.work_package_id = NEW.work_package_id
       AND current.version = NEW.work_package_version
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.stop_active = 1
       AND (
         occurrence.scope_type = 'tenant'
         OR EXISTS (
           SELECT 1 FROM safety_stop_unresolved_scopes latch
            WHERE latch.tenant_id = occurrence.tenant_id AND latch.occurrence_id = occurrence.occurrence_id
         )
         OR (occurrence.scope_type = 'roof_job' AND (
           -- Only the committed typed object or its explicit Roof Job physical parent can
           -- stand on this job. A universal object's compatibility job_id is not a relation.
           occurrence.scope_id = CASE
             WHEN current.work_object_type = 'Roof Job' THEN current.work_object_id
             WHEN current.physical_context_type = 'Roof Job' THEN current.physical_context_id
             ELSE NULL END
           OR NOT EXISTS (
             SELECT 1
               FROM operating_roof_jobs job
              WHERE job.tenant_id = occurrence.tenant_id
                AND job.roof_job_id = occurrence.scope_id
           )
         ))
         OR (occurrence.scope_type = 'work_package' AND (
           EXISTS (
             SELECT 1
               FROM work_packages package
              WHERE package.tenant_id = occurrence.tenant_id
                AND package.work_package_id = occurrence.scope_id
                AND (
                  (package.work_object_type = current.work_object_type
                   AND package.work_object_id = current.work_object_id
                   AND package.physical_context_type = current.physical_context_type
                   AND package.physical_context_id = current.physical_context_id)
                  OR (
                    CASE
                      WHEN package.work_object_type = 'Roof Job' THEN package.work_object_id
                      WHEN package.physical_context_type = 'Roof Job' THEN package.physical_context_id
                      ELSE NULL END
                    = CASE
                      WHEN current.work_object_type = 'Roof Job' THEN current.work_object_id
                      WHEN current.physical_context_type = 'Roof Job' THEN current.physical_context_id
                      ELSE NULL END
                  )
                )
           )
           OR NOT EXISTS (
             SELECT 1
               FROM work_packages package
              WHERE package.tenant_id = occurrence.tenant_id
                AND package.work_package_id = occurrence.scope_id
           )
         ))
       )
  );
END;

ALTER TABLE safety_occurrence_events ADD COLUMN confirmed_by_user_id TEXT;

-- SQLite REPLACE does not run delete triggers unless recursive_triggers is enabled. Protect
-- both conflict keys before insertion so the original confirmer and evidence cannot be replaced.
CREATE TRIGGER safety_occurrence_events_no_replace
BEFORE INSERT ON safety_occurrence_events
WHEN EXISTS (
  SELECT 1 FROM safety_occurrence_events event
   WHERE event.event_id = NEW.event_id
      OR (event.tenant_id = NEW.tenant_id AND event.occurrence_id = NEW.occurrence_id
          AND event.occurrence_version = NEW.occurrence_version AND event.event_kind = NEW.event_kind)
)
BEGIN SELECT RAISE(ABORT, 'safety_occurrence_events_append_only'); END;

CREATE TRIGGER safety_occurrence_events_make_safe_confirmer
BEFORE INSERT ON safety_occurrence_events
BEGIN
  SELECT RAISE(ABORT, 'safety_make_safe_confirmer_not_applicable')
  WHERE NEW.confirmed_by_user_id IS NOT NULL AND NEW.event_kind != 'make_safe';

  SELECT RAISE(ABORT, 'safety_make_safe_confirmer_required')
  WHERE NEW.event_kind = 'make_safe'
    AND NEW.actor_role != 'field'
    AND NEW.confirmed_by_user_id IS NULL;

  SELECT RAISE(ABORT, 'safety_make_safe_confirmer_unknown')
  WHERE NEW.confirmed_by_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM app_users confirmer
       WHERE confirmer.tenant_id = NEW.tenant_id
         AND confirmer.user_id = NEW.confirmed_by_user_id
         AND confirmer.active = 1
    );

  -- The confirmer is someone other than the person recording it, under any identity.
  SELECT RAISE(ABORT, 'safety_make_safe_confirmer_is_recorder')
  WHERE NEW.confirmed_by_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM app_users confirmer
        JOIN app_users recorder
          ON recorder.tenant_id = confirmer.tenant_id
         AND recorder.user_id = NEW.actor_user_id
       WHERE confirmer.tenant_id = NEW.tenant_id
         AND confirmer.user_id = NEW.confirmed_by_user_id
         AND (
           lower(confirmer.user_id) IN (
             lower(recorder.user_id), recorder.email_normalized, lower(trim(recorder.frappe_user_id))
           )
           OR confirmer.email_normalized IN (
             lower(recorder.user_id), recorder.email_normalized, lower(trim(recorder.frappe_user_id))
           )
           OR lower(trim(confirmer.frappe_user_id)) IN (
             lower(recorder.user_id), recorder.email_normalized, lower(trim(recorder.frappe_user_id))
           )
         )
    );
END;

CREATE TRIGGER safety_occurrences_made_safe_event_guard
BEFORE UPDATE ON safety_occurrences
WHEN OLD.state = 'reported' AND NEW.state = 'made_safe'
BEGIN
  SELECT RAISE(ABORT, 'safety_make_safe_event_required')
  WHERE NOT EXISTS (
    SELECT 1
      FROM safety_occurrence_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.occurrence_id = NEW.occurrence_id
       AND event.occurrence_version = NEW.version
       AND event.event_kind = 'make_safe'
  );
END;

CREATE TABLE IF NOT EXISTS safety_stop_keep_decisions (
  keep_id TEXT PRIMARY KEY CHECK (
    length(keep_id) = 36 AND keep_id GLOB 'ssk_*' AND substr(keep_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 140
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  occurrence_id TEXT NOT NULL,
  occurrence_version INTEGER NOT NULL CHECK (occurrence_version BETWEEN 1 AND 1000000),
  kept_by_user_id TEXT NOT NULL,
  kept_by_role TEXT NOT NULL CHECK (kept_by_role IN ('owner', 'ops', 'production')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 4000),
  kept_at TEXT NOT NULL CHECK (length(kept_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (occurrence_id, tenant_id)
    REFERENCES safety_occurrences(occurrence_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (kept_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_safety_stop_keep_decisions_occurrence
  ON safety_stop_keep_decisions (tenant_id, occurrence_id, kept_at DESC);

CREATE TRIGGER safety_stop_keep_decisions_validate_insert
BEFORE INSERT ON safety_stop_keep_decisions
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users keeper
     WHERE keeper.tenant_id = NEW.tenant_id
       AND keeper.user_id = NEW.kept_by_user_id
       AND keeper.active = 1
       AND COALESCE(keeper.access_role, keeper.role) = NEW.kept_by_role
  );

  SELECT RAISE(ABORT, 'safety_occurrence_not_found')
  WHERE NOT EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id AND occurrence.occurrence_id = NEW.occurrence_id
  );

  SELECT RAISE(ABORT, 'safety_stop_already_released')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND occurrence.stop_active != 1
  );

  -- The decision names the version the person reviewed, and it is still the current one.
  SELECT RAISE(ABORT, 'safety_occurrence_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND occurrence.version = NEW.occurrence_version
  );

  -- Keeping is the release decision's other answer, so the raiser never records it either.
  SELECT RAISE(ABORT, 'safety_stop_release_by_raiser_forbidden')
  WHERE EXISTS (
    SELECT 1
      FROM safety_occurrences occurrence
      JOIN app_users keeper
        ON keeper.tenant_id = occurrence.tenant_id
       AND keeper.user_id = NEW.kept_by_user_id
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND (
         lower(trim(occurrence.reported_by_user_id)) IN (
           lower(keeper.user_id), keeper.email_normalized, lower(trim(keeper.frappe_user_id))
         )
         OR EXISTS (
           SELECT 1
             FROM app_users raiser
            WHERE raiser.tenant_id = occurrence.tenant_id
              AND raiser.user_id = occurrence.reported_by_user_id
              AND (
                lower(raiser.user_id) IN (
                  lower(keeper.user_id), keeper.email_normalized, lower(trim(keeper.frappe_user_id))
                )
                OR raiser.email_normalized IN (
                  lower(keeper.user_id), keeper.email_normalized, lower(trim(keeper.frappe_user_id))
                )
                OR lower(trim(raiser.frappe_user_id)) IN (
                  lower(keeper.user_id), keeper.email_normalized, lower(trim(keeper.frappe_user_id))
                )
              )
         )
       )
  );

  -- When it was kept is D1's clock, not the caller's.
  SELECT RAISE(ABORT, 'safety_stop_keep_clock_invalid')
  WHERE NEW.kept_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER safety_stop_keep_decisions_no_insert_replace
BEFORE INSERT ON safety_stop_keep_decisions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_keep_append_only')
  WHERE EXISTS (
    SELECT 1 FROM safety_stop_keep_decisions existing
     WHERE existing.keep_id = NEW.keep_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.idempotency_key = NEW.idempotency_key)
  );
END;

CREATE TRIGGER safety_stop_keep_decisions_append_only_update
BEFORE UPDATE ON safety_stop_keep_decisions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_keep_append_only');
END;

CREATE TRIGGER safety_stop_keep_decisions_append_only_delete
BEFORE DELETE ON safety_stop_keep_decisions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_keep_retained');
END;

-- Typed Roof Job relationships in predecessor production guards.
-- These exact current guards retain every non-Safety assertion. Only native work-object
-- relationship matching and the immutable unresolved-scope latch change.

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

  -- [0155] Only a superseding contract reverses `contract_no_deposit`; a person never does.
  SELECT RAISE(ABORT, 'production_gate_contract_no_deposit_not_reversible')
  WHERE NEW.actor_kind IS NOT 'policy'
    AND NEW.reverses_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances reversed
       WHERE reversed.tenant_id = NEW.tenant_id
         AND reversed.clearance_id = NEW.reverses_id
         AND reversed.basis = 'contract_no_deposit'
    );

  -- [0158] Only a person clears Safety: no agent and no policy ever attests it.
  SELECT RAISE(ABORT, 'production_gate_safety_person_only')
  WHERE NEW.gate = 'Safety' AND NEW.entry_kind = 'clear' AND NEW.actor_kind IS NOT 'person';

  -- [0155] A policy entry is the Deposit gate's, under `ironwrap.deposit-gate.v1`: `clear` with
  -- `contract_no_deposit`, or the `reverse` a superseding contract makes, `contract_superseded`.
  -- It names the contract it was read from and carries no person, request, reason or attestation,
  -- so the person rules below never apply to it.
  SELECT RAISE(ABORT, 'production_gate_clearance_basis_invalid')
  WHERE NEW.actor_kind = 'policy'
    -- [0159] Scoped to every policy entry but the Crew gate's; the rules after it check those.
    AND NEW.gate != 'Crew'
    AND NOT (
      NEW.gate = 'Deposit'
      AND NEW.policy_version IS 'ironwrap.deposit-gate.v1'
      AND NEW.actor_user_id IS NULL AND NEW.actor_role IS NULL
      AND NEW.requested_by IS NULL AND NEW.request_id IS NULL AND NEW.self_approval = 0
      AND NEW.reason IS NULL AND NEW.reason_redacted_at IS NULL AND NEW.attestation_json IS NULL
      AND NEW.contract_binding_id IS NOT NULL AND NEW.terms_hash IS NOT NULL
      AND NEW.evidence_refs_json IS NOT NULL
      AND (
        (NEW.entry_kind = 'clear' AND NEW.basis = 'contract_no_deposit'
          AND NEW.to_state = 'complete' AND NEW.reverses_id IS NULL)
        OR (NEW.entry_kind = 'reverse' AND NEW.basis = 'contract_superseded'
          AND NEW.to_state = 'blocked' AND NEW.reverses_id IS NOT NULL)
      )
    );

  -- [0159] A policy entry on Crew is the schedule's, under `ironwrap.crew-gate.v1`: `clear` with
  -- `crew_assignment`, which binds Crew to the crew a schedule names at that crew's version, or the
  -- `reverse` a schedule naming another crew or crew version appends first, `crew_superseded`. It
  -- carries no person, request, reason, attestation or contract, so the person rules below never
  -- apply to it. Crew has no waiver and no person clear.
  SELECT RAISE(ABORT, 'production_gate_clearance_basis_invalid')
  WHERE NEW.actor_kind = 'policy'
    AND NEW.gate = 'Crew'
    AND NOT (
      NEW.policy_version IS 'ironwrap.crew-gate.v1'
      AND NEW.actor_user_id IS NULL AND NEW.actor_role IS NULL
      AND NEW.requested_by IS NULL AND NEW.request_id IS NULL AND NEW.self_approval = 0
      AND NEW.reason IS NULL AND NEW.reason_redacted_at IS NULL AND NEW.attestation_json IS NULL
      AND NEW.contract_binding_id IS NULL AND NEW.terms_hash IS NULL
      AND NEW.evidence_refs_json IS NOT NULL
      AND (
        (NEW.entry_kind = 'clear' AND NEW.basis = 'crew_assignment'
          AND NEW.to_state = 'complete' AND NEW.reverses_id IS NULL)
        OR (NEW.entry_kind = 'reverse' AND NEW.basis = 'crew_superseded'
          AND NEW.to_state = 'blocked' AND NEW.reverses_id IS NOT NULL)
      )
    );

  -- [0159] Its evidence is the binding and nothing else, as plain JSON: the assignment that makes
  -- it, the crew and the crew version, each once. JSON5 or a second copy of a key would pass the
  -- reads below and then fail every reader that parses the stored evidence.
  SELECT RAISE(ABORT, 'production_gate_evidence_invalid')
  WHERE NEW.actor_kind = 'policy' AND NEW.gate = 'Crew' AND NOT json_valid(NEW.evidence_refs_json);
  SELECT RAISE(ABORT, 'production_gate_evidence_invalid')
  WHERE NEW.actor_kind = 'policy'
    AND NEW.gate = 'Crew'
    AND (
      json_type(NEW.evidence_refs_json) IS NOT 'object'
      OR (SELECT COUNT(*) FROM json_each(NEW.evidence_refs_json)) != 3
      OR (SELECT COUNT(DISTINCT key) FROM json_each(NEW.evidence_refs_json)) != 3
      OR json_type(NEW.evidence_refs_json, '$.assignment_id') IS NOT 'text'
      OR json_type(NEW.evidence_refs_json, '$.crew_id') IS NOT 'text'
      OR json_type(NEW.evidence_refs_json, '$.crew_version') IS NOT 'integer'
    );

  -- [0159] The crew it names is the one 0098 admits to a schedule: this tenant's crew, Active at
  -- exactly that version, with at least one active member and every active member an active field
  -- user.
  SELECT RAISE(ABORT, 'production_gate_crew_binding_invalid')
  WHERE NEW.actor_kind = 'policy'
    AND NEW.gate = 'Crew'
    AND (
      NOT EXISTS (
        SELECT 1
          FROM fleet_crews crew
         WHERE crew.tenant_id = NEW.tenant_id
           AND crew.crew_id = json_extract(NEW.evidence_refs_json, '$.crew_id')
           AND crew.version = json_extract(NEW.evidence_refs_json, '$.crew_version')
           AND crew.status = 'Active'
      )
      OR NOT EXISTS (
        SELECT 1
          FROM fleet_crew_members membership
         WHERE membership.tenant_id = NEW.tenant_id
           AND membership.crew_id = json_extract(NEW.evidence_refs_json, '$.crew_id')
           AND membership.active = 1
      )
      OR EXISTS (
        SELECT 1
          FROM fleet_crew_members membership
          LEFT JOIN app_users worker
            ON worker.tenant_id = membership.tenant_id
           AND worker.user_id = membership.user_id
         WHERE membership.tenant_id = NEW.tenant_id
           AND membership.crew_id = json_extract(NEW.evidence_refs_json, '$.crew_id')
           AND membership.active = 1
           AND (worker.user_id IS NULL OR worker.active != 1 OR worker.access_role != 'field')
      )
    );

  -- [0159] A schedule appends its Crew entries in the same batch as its assignment, ahead of it, so
  -- the assignment an entry names is not written yet.
  SELECT RAISE(ABORT, 'production_gate_crew_binding_invalid')
  WHERE NEW.actor_kind = 'policy'
    AND NEW.gate = 'Crew'
    AND EXISTS (
      SELECT 1
        FROM operating_job_assignments assignment
       WHERE assignment.tenant_id = NEW.tenant_id
         AND assignment.assignment_id = json_extract(NEW.evidence_refs_json, '$.assignment_id')
    );

  -- [0159] A schedule re-binds Crew only to another crew or crew version than the one the entry
  -- it reverses is bound to.
  SELECT RAISE(ABORT, 'production_gate_crew_binding_invalid')
  WHERE NEW.actor_kind = 'policy'
    AND NEW.gate = 'Crew'
    AND NEW.entry_kind = 'reverse'
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances reversed
       WHERE reversed.tenant_id = NEW.tenant_id
         AND reversed.clearance_id = NEW.reverses_id
         AND reversed.basis = 'crew_assignment'
         AND CASE WHEN json_valid(reversed.evidence_refs_json) THEN
           json_extract(reversed.evidence_refs_json, '$.crew_id')
             = json_extract(NEW.evidence_refs_json, '$.crew_id')
           AND json_extract(reversed.evidence_refs_json, '$.crew_version')
             = json_extract(NEW.evidence_refs_json, '$.crew_version')
         END
    );

  -- The basis x gate matrix this migration admits, all of it person entries.
  -- [0155] Scoped to every entry that is not a policy entry; the rule above checks those.
  -- [0158] It admits the person's attestation and reversal.
  SELECT RAISE(ABORT, 'production_gate_clearance_basis_invalid')
  WHERE NEW.actor_kind IS NOT 'policy' AND (NOT (
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
        AND NEW.evidence_refs_json IS NOT NULL));

  -- Each admitted entry acts on a blocked gate.
  -- [0155] Except the policy's `contract_superseded` reversal, which acts on the gate it reverses.
  -- [0158] And the person's reversal: every reversal acts on a gate that is not blocked.
  SELECT RAISE(ABORT, 'production_gate_already_cleared')
  WHERE NEW.entry_kind IS NOT 'reverse' AND NOT EXISTS (
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
  -- [0155] Scoped to person entries; a policy entry names no user.
  SELECT RAISE(ABORT, 'production_gate_clearance_actor_invalid')
  WHERE NEW.actor_kind = 'person' AND NOT EXISTS (
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

  -- [0158] `production.gates.clear` (owner, production) clears on settlement, attests, requests a waiver
  -- and reverses. `production.gates.safety` ("checks site safety") attests Safety and is carried
  -- today by the same two roles. The decider holds the matching set: `money.approve` for Deposit,
  -- `production.gates.waive` for Materials and Access. Today the owner carries both.
  SELECT RAISE(ABORT, 'production_gate_clearance_actor_invalid')
  WHERE (NEW.entry_kind IN ('clear', 'waiver_request', 'reverse')
         AND NEW.actor_role NOT IN ('owner', 'production'))
     OR (NEW.basis = 'person_attestation' AND NEW.gate = 'Safety'
         AND NEW.actor_role NOT IN ('owner', 'production'))
     OR (NEW.entry_kind = 'waiver_decision' AND NEW.actor_role != 'owner');

  -- [0158] A person's reversal states its reason too; the policy's carries none.
  SELECT RAISE(ABORT, 'production_gate_clearance_reason_required')
  WHERE (NEW.entry_kind IN ('waiver_request', 'waiver_decision') OR NEW.basis = 'person_reversal')
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

  -- [0158] An attester is on no crew: no active crew membership names a login that shares the attester's
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

  -- [0158] One small typed shape per gate and no free text but a note of at most 300 characters.
  -- References are short identifiers, never prose. Times are UTC instants as the Worker writes
  -- them, and a time something was observed, confirmed or assessed is never in the future. A key
  -- appears once: a second copy would escape every check below, which reads only the first.
  SELECT RAISE(ABORT, 'production_gate_attestation_invalid')
  WHERE NEW.basis = 'person_attestation'
    AND (
      (NEW.reason IS NOT NULL AND length(NEW.reason) > 300)
      OR json_type(NEW.attestation_json) IS NOT 'object'
      OR (SELECT COUNT(*) FROM json_each(NEW.attestation_json))
        != (SELECT COUNT(DISTINCT key) FROM json_each(NEW.attestation_json))
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
               'hazard_assessment_ref', 'permit', 'fall_protection', 'assessed_at', 'competency'))
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
        -- The permit answer: exactly {answer} when not needed or unknown, and exactly
        -- {answer, number} when held, the number a reference whose words single spaces join.
        OR json_type(NEW.attestation_json, '$.permit') IS NOT 'object'
        OR json_type(NEW.attestation_json, '$.permit.answer') IS NOT 'text'
        OR json_extract(NEW.attestation_json, '$.permit.answer') NOT IN (
          'needed_and_held', 'not_needed', 'unknown'
        )
        OR (SELECT COUNT(*) FROM json_each(NEW.attestation_json, '$.permit'))
          != CASE json_extract(NEW.attestation_json, '$.permit.answer')
               WHEN 'needed_and_held' THEN 2 ELSE 1 END
        OR (json_extract(NEW.attestation_json, '$.permit.answer') = 'needed_and_held' AND NOT (
          json_type(NEW.attestation_json, '$.permit.number') IS 'text'
          AND length(json_extract(NEW.attestation_json, '$.permit.number')) BETWEEN 1 AND 80
          AND json_extract(NEW.attestation_json, '$.permit.number') GLOB '[A-Za-z0-9]*'
          AND json_extract(NEW.attestation_json, '$.permit.number')
            NOT GLOB '*[^A-Za-z0-9 ._:/#-]*'
          AND json_extract(NEW.attestation_json, '$.permit.number') NOT GLOB '*  *'
          AND json_extract(NEW.attestation_json, '$.permit.number') NOT GLOB '* '
        ))
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

  -- [0158] The evidence list is plain JSON as the Worker writes it. JSON5 would pass json_each below and
  -- then fail every reader that parses the stored list. This relies on one-argument json_valid
  -- refusing JSON5 while json_each and json_type read it, as in SQLite 3.45 and later. D1 does not
  -- let a query read sqlite_version(); wrangler 4.151.0's local D1 (workerd 1.20261012.1) behaves
  -- so, and tools/d1-gate-ledger-probe.mjs checks it against that engine on every worker-contract run.
  SELECT RAISE(ABORT, 'production_gate_evidence_invalid')
  WHERE NEW.basis = 'person_attestation' AND NOT json_valid(NEW.evidence_refs_json);

  -- [0158] 0 to 10 distinct references, each resolved by the Worker against this job: exactly one
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

  -- [0158] Materials is never attested over an inventory exception of the job that is open or contained,
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

  -- [0158] An unknown permit answer is a well-formed Safety proof that never clears the gate. It has
  -- its own code, so the person is asked to change the answer rather than the proof's shape.
  SELECT RAISE(ABORT, 'production_gate_safety_permit_unknown')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Safety'
    AND json_extract(NEW.attestation_json, '$.permit.answer') = 'unknown';

  -- [0158] An active safety stop naming a job this tenant does not have may be a typo for any of its
  -- jobs, so it holds Safety on every job of the tenant until it is lifted. Its own code says a
  -- stop names a job that doesn't exist. Nothing refuses such a stop when it is recorded: a person
  -- may always stop work.
  SELECT RAISE(ABORT, 'production_gate_stop_job_unknown')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Safety'
    AND EXISTS (
      SELECT 1
        FROM safety_occurrences occurrence
       WHERE occurrence.tenant_id = NEW.tenant_id
         AND occurrence.stop_active = 1
         AND occurrence.scope_type = 'roof_job'
         AND (EXISTS (SELECT 1 FROM safety_stop_unresolved_scopes latch
                      WHERE latch.tenant_id = occurrence.tenant_id
                        AND latch.occurrence_id = occurrence.occurrence_id) OR NOT EXISTS (
           SELECT 1 FROM operating_roof_jobs job
            WHERE job.tenant_id = occurrence.tenant_id AND job.roof_job_id = occurrence.scope_id
         ))
    );

  -- [0159] An active safety stop naming a Work Package this tenant does not have maps to no job: it
  -- may be meant for a package of any of its jobs, so it holds Safety on every job of the tenant
  -- until it is lifted. Its own code says a stop names a work package that doesn't exist. Nothing
  -- refuses such a stop when it is recorded: a person may always stop work.
  SELECT RAISE(ABORT, 'production_gate_stop_work_package_unknown')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Safety'
    AND EXISTS (
      SELECT 1
        FROM safety_occurrences occurrence
       WHERE occurrence.tenant_id = NEW.tenant_id
         AND occurrence.stop_active = 1
         AND occurrence.scope_type = 'work_package'
         AND (EXISTS (SELECT 1 FROM safety_stop_unresolved_scopes latch
                      WHERE latch.tenant_id = occurrence.tenant_id
                        AND latch.occurrence_id = occurrence.occurrence_id) OR NOT EXISTS (
           SELECT 1
             FROM work_packages package
            WHERE package.tenant_id = occurrence.tenant_id
              AND package.work_package_id = occurrence.scope_id
         ))
    );

  -- [0158] Safety is never attested while an active stop applies to the job: a safety stop on the
  -- whole tenant, on the job, or on any Work Package of the job in any status, Superseded included;
  -- or a crew's stop_work on any Work Package of the job that no release has lifted (0145). A
  -- safety stop whose scope cannot be resolved holds it too: a scope type this rule does not know,
  -- or a Work Package that maps to no job. A stop on another job, on a shop or on a vehicle does not.
  SELECT RAISE(ABORT, 'production_gate_safety_stop_active')
  WHERE NEW.basis = 'person_attestation'
    AND NEW.gate = 'Safety'
    AND (
      EXISTS (
        SELECT 1
          FROM safety_occurrences occurrence
         WHERE occurrence.tenant_id = NEW.tenant_id
           AND occurrence.stop_active = 1
           AND (
             occurrence.scope_type = 'tenant'
             OR EXISTS (SELECT 1 FROM safety_stop_unresolved_scopes latch
                      WHERE latch.tenant_id = occurrence.tenant_id
                        AND latch.occurrence_id = occurrence.occurrence_id)
             OR (occurrence.scope_type = 'roof_job' AND occurrence.scope_id = NEW.roof_job_id)
             OR (occurrence.scope_type = 'work_package' AND (
               occurrence.scope_id IN (
                 SELECT package.work_package_id
                   FROM work_packages package
                  WHERE package.tenant_id = NEW.tenant_id
                    AND (CASE WHEN package.work_object_type = 'Roof Job' THEN package.work_object_id
                          WHEN package.physical_context_type = 'Roof Job' THEN package.physical_context_id
                          ELSE NULL END) = NEW.roof_job_id
               )
               OR NOT EXISTS (
                 SELECT 1
                   FROM work_packages package
                  WHERE package.tenant_id = occurrence.tenant_id
                    AND package.work_package_id = occurrence.scope_id
               )
             ))
             OR occurrence.scope_type NOT IN ('tenant', 'roof_job', 'work_package', 'shop', 'vehicle')
           )
      )
      OR EXISTS (
        SELECT 1
          FROM work_package_events crew_stop
         WHERE crew_stop.tenant_id = NEW.tenant_id
           AND crew_stop.event_kind = 'stop_work'
           AND crew_stop.work_package_id IN (
             SELECT package.work_package_id
               FROM work_packages package
              WHERE package.tenant_id = NEW.tenant_id
                AND (CASE WHEN package.work_object_type = 'Roof Job' THEN package.work_object_id
                          WHEN package.physical_context_type = 'Roof Job' THEN package.physical_context_id
                          ELSE NULL END) = NEW.roof_job_id
           )
           AND NOT EXISTS (
             SELECT 1
               FROM work_package_stop_releases released
              WHERE released.tenant_id = crew_stop.tenant_id
                AND released.stop_event_id = crew_stop.event_id
           )
      )
    );

  -- [0158] Safety names the attester's current internal Worker Competency in site safety: the latest
  -- version of its record, with no contradicting copy of that version, superseded by no other
  -- record, verified by an internal assessment, not revoked, in force today and not bound to another
  -- job. Its scope is exactly the closed token `site_safety`, the `authority_scope` this migration
  -- names for "checks site safety"; no other text counts. Its person is any login coordinate the
  -- attester carries.
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
         AND competency.authority_scope = 'site_safety'
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

  -- [0158] Weather rests on a forecast observed at most 72 hours ago, for a window of at most 14 days that
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

  -- [0158] A reversal names the entry that holds the gate's current state: the one its current version
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

  -- [0155] `contract_no_deposit` (OD-01): the job's latest accepted contract, exactly as its
  -- binding recorded it, carries no deposit and is paid on completion.
  SELECT RAISE(ABORT, 'production_gate_contract_no_deposit_not_observed')
  WHERE NEW.basis = 'contract_no_deposit'
    AND NOT EXISTS (
      SELECT 1
        FROM commercial_acceptance_bindings binding
        JOIN customer_portal_acceptance_intents acceptance
          ON acceptance.tenant_id = binding.tenant_id
         AND acceptance.acceptance_id = binding.acceptance_id
         AND acceptance.state = 'accepted'
        JOIN commercial_quote_revisions quote
          ON quote.tenant_id = binding.tenant_id
         AND quote.quote_revision_id = binding.quote_revision_id
       WHERE binding.tenant_id = NEW.tenant_id
         AND binding.roof_job_id = NEW.roof_job_id
         AND binding.acceptance_binding_id = NEW.contract_binding_id
         AND binding.terms_hash = NEW.terms_hash
         AND quote.terms_hash = binding.terms_hash
         AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
         AND json_extract(quote.terms_json, '$.deposit_percent') = 0
         AND json_type(quote.terms_json, '$.payment_schedule') = 'array'
         AND json_array_length(quote.terms_json, '$.payment_schedule') = 1
         AND json_extract(quote.terms_json, '$.payment_schedule[0]') = 'completion'
         AND NOT EXISTS (
           SELECT 1
             FROM commercial_acceptance_bindings later
            WHERE later.tenant_id = binding.tenant_id
              AND later.roof_job_id = binding.roof_job_id
              AND (later.accepted_at > binding.accepted_at
                   OR (later.accepted_at = binding.accepted_at
                       AND later.acceptance_binding_id > binding.acceptance_binding_id))
         )
    );
  -- [0155] ... and the tenant's deposit policy is payment on completion. No revision means OD-01.
  SELECT RAISE(ABORT, 'deposit_terms_not_allowed_by_policy')
  WHERE NEW.basis = 'contract_no_deposit'
    AND COALESCE((
      SELECT revision.policy FROM tenant_deposit_policy_revisions revision
       WHERE revision.tenant_id = NEW.tenant_id
       ORDER BY revision.revision DESC LIMIT 1
    ), 'od01_payment_on_completion') != 'od01_payment_on_completion';

  -- [0155] `contract_superseded` (the MD-13 branch): the job's latest accepted contract is a later
  -- one that carries a deposit, and the entry reversed is the `contract_no_deposit` entry the
  -- Deposit gate stands on now.
  SELECT RAISE(ABORT, 'production_gate_contract_superseded_not_observed')
  WHERE NEW.basis = 'contract_superseded'
    AND NOT (
      EXISTS (
        SELECT 1
          FROM operating_production_gates gate
          JOIN production_gate_clearances reversed
            ON reversed.tenant_id = gate.tenant_id
           AND reversed.clearance_id = gate.clearance_decision_id
         WHERE gate.tenant_id = NEW.tenant_id
           AND gate.gate_id = NEW.gate_id
           AND gate.state = 'complete'
           AND reversed.clearance_id = NEW.reverses_id
           AND reversed.gate_id = NEW.gate_id
           AND reversed.basis = 'contract_no_deposit'
           AND reversed.contract_binding_id IS NOT NEW.contract_binding_id
      )
      AND EXISTS (
        SELECT 1
          FROM commercial_acceptance_bindings binding
          JOIN customer_portal_acceptance_intents acceptance
            ON acceptance.tenant_id = binding.tenant_id
           AND acceptance.acceptance_id = binding.acceptance_id
           AND acceptance.state = 'accepted'
          JOIN commercial_quote_revisions quote
            ON quote.tenant_id = binding.tenant_id
           AND quote.quote_revision_id = binding.quote_revision_id
         WHERE binding.tenant_id = NEW.tenant_id
           AND binding.roof_job_id = NEW.roof_job_id
           AND binding.acceptance_binding_id = NEW.contract_binding_id
           AND binding.terms_hash = NEW.terms_hash
           AND quote.terms_hash = binding.terms_hash
           AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
           AND json_extract(quote.terms_json, '$.deposit_percent') BETWEEN 1 AND 100
           AND NOT EXISTS (
             SELECT 1
               FROM commercial_acceptance_bindings later
              WHERE later.tenant_id = binding.tenant_id
                AND later.roof_job_id = binding.roof_job_id
                AND (later.accepted_at > binding.accepted_at
                     OR (later.accepted_at = binding.accepted_at
                         AND later.acceptance_binding_id > binding.acceptance_binding_id))
           )
      )
    );

  -- [0155] Once a superseding contract has re-blocked Deposit, a settlement is made of the
  -- deposit invoice derived from the job's latest accepted contract, not of any deposit invoice.
  SELECT RAISE(ABORT, 'deposit_settlement_not_observed')
  WHERE NEW.basis = 'deposit_settlement'
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances superseded
       WHERE superseded.tenant_id = NEW.tenant_id
         AND superseded.gate_id = NEW.gate_id
         AND superseded.basis = 'contract_superseded'
    )
    AND NOT EXISTS (
      SELECT 1
        FROM commercial_acceptance_bindings binding
        JOIN commercial_deposit_derivations derivation
          ON derivation.tenant_id = binding.tenant_id
         AND derivation.acceptance_binding_id = binding.acceptance_binding_id
       WHERE binding.tenant_id = NEW.tenant_id
         AND binding.roof_job_id = NEW.roof_job_id
         AND derivation.intent_id = CASE
           WHEN json_valid(NEW.evidence_refs_json)
             THEN json_extract(NEW.evidence_refs_json, '$.money_intent_id')
         END
         AND NOT EXISTS (
           SELECT 1
             FROM commercial_acceptance_bindings later
            WHERE later.tenant_id = binding.tenant_id
              AND later.roof_job_id = binding.roof_job_id
              AND (later.accepted_at > binding.accepted_at
                   OR (later.accepted_at = binding.accepted_at
                       AND later.acceptance_binding_id > binding.acceptance_binding_id))
         )
    );
END;

DROP TRIGGER operating_job_assignments_gate_evidence_guard;

CREATE TRIGGER operating_job_assignments_gate_evidence_guard
BEFORE INSERT ON operating_job_assignments
BEGIN
  -- The QA seed owner never clears a gate, and a schedule clears Crew by policy, so it never
  -- schedules either.
  SELECT RAISE(ABORT, 'operating_job_assignment_seed_identity_refused')
  WHERE EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.actor_user_id
       AND actor.created_by = 'system:owner_directed_qa_seed_grant'
  );

  -- A stop naming a job this tenant does not have may be a typo for any of its jobs, so it holds
  -- every schedule of the tenant until it is lifted, as it holds every Safety attestation. This is
  -- 0158's rule, carried here unchanged; a test pins the two together.
  SELECT RAISE(ABORT, 'operating_job_assignment_stop_job_unknown')
  WHERE EXISTS (
      SELECT 1
        FROM safety_occurrences occurrence
       WHERE occurrence.tenant_id = NEW.tenant_id
         AND occurrence.stop_active = 1
         AND occurrence.scope_type = 'roof_job'
         AND (EXISTS (SELECT 1 FROM safety_stop_unresolved_scopes latch
                      WHERE latch.tenant_id = occurrence.tenant_id
                        AND latch.occurrence_id = occurrence.occurrence_id) OR NOT EXISTS (
           SELECT 1 FROM operating_roof_jobs job
            WHERE job.tenant_id = occurrence.tenant_id AND job.roof_job_id = occurrence.scope_id
         ))
    );

  -- So does a stop naming a Work Package this tenant does not have: the rule the validate guard
  -- above holds a Safety attestation to, carried unchanged.
  SELECT RAISE(ABORT, 'operating_job_assignment_stop_work_package_unknown')
  WHERE EXISTS (
      SELECT 1
        FROM safety_occurrences occurrence
       WHERE occurrence.tenant_id = NEW.tenant_id
         AND occurrence.stop_active = 1
         AND occurrence.scope_type = 'work_package'
         AND (EXISTS (SELECT 1 FROM safety_stop_unresolved_scopes latch
                      WHERE latch.tenant_id = occurrence.tenant_id
                        AND latch.occurrence_id = occurrence.occurrence_id) OR NOT EXISTS (
           SELECT 1
             FROM work_packages package
            WHERE package.tenant_id = occurrence.tenant_id
              AND package.work_package_id = occurrence.scope_id
         ))
    );

  -- No active stop applies to the job: a safety stop on the tenant, on the job or on any Work
  -- Package of the job, Superseded included; a crew's stop_work on one of them that no release has
  -- lifted (0145); or a safety stop whose scope cannot be resolved. This is the stop rule 0158 holds
  -- a Safety attestation to, carried here unchanged so a Safety gate attested before a new stop
  -- still holds the schedule; a test pins the two together.
  SELECT RAISE(ABORT, 'operating_job_assignment_stop_active')
  WHERE (
      EXISTS (
        SELECT 1
          FROM safety_occurrences occurrence
         WHERE occurrence.tenant_id = NEW.tenant_id
           AND occurrence.stop_active = 1
           AND (
             occurrence.scope_type = 'tenant'
             OR EXISTS (SELECT 1 FROM safety_stop_unresolved_scopes latch
                      WHERE latch.tenant_id = occurrence.tenant_id
                        AND latch.occurrence_id = occurrence.occurrence_id)
             OR (occurrence.scope_type = 'roof_job' AND occurrence.scope_id = NEW.roof_job_id)
             OR (occurrence.scope_type = 'work_package' AND (
               occurrence.scope_id IN (
                 SELECT package.work_package_id
                   FROM work_packages package
                  WHERE package.tenant_id = NEW.tenant_id
                    AND (CASE WHEN package.work_object_type = 'Roof Job' THEN package.work_object_id
                          WHEN package.physical_context_type = 'Roof Job' THEN package.physical_context_id
                          ELSE NULL END) = NEW.roof_job_id
               )
               OR NOT EXISTS (
                 SELECT 1
                   FROM work_packages package
                  WHERE package.tenant_id = occurrence.tenant_id
                    AND package.work_package_id = occurrence.scope_id
               )
             ))
             OR occurrence.scope_type NOT IN ('tenant', 'roof_job', 'work_package', 'shop', 'vehicle')
           )
      )
      OR EXISTS (
        SELECT 1
          FROM work_package_events crew_stop
         WHERE crew_stop.tenant_id = NEW.tenant_id
           AND crew_stop.event_kind = 'stop_work'
           AND crew_stop.work_package_id IN (
             SELECT package.work_package_id
               FROM work_packages package
              WHERE package.tenant_id = NEW.tenant_id
                AND (CASE WHEN package.work_object_type = 'Roof Job' THEN package.work_object_id
                          WHEN package.physical_context_type = 'Roof Job' THEN package.physical_context_id
                          ELSE NULL END) = NEW.roof_job_id
           )
           AND NOT EXISTS (
             SELECT 1
               FROM work_package_stop_releases released
              WHERE released.tenant_id = crew_stop.tenant_id
                AND released.stop_event_id = crew_stop.event_id
           )
      )
    );

  -- Crew stands on the policy's `crew_assignment` entry bound to this crew at this version, made by
  -- this schedule or an earlier one of the same job. An entry from before the ledger may hold any
  -- evidence text, so it is read only once it parses.
  SELECT RAISE(ABORT, 'operating_job_assignment_crew_gate_unbound')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
      JOIN production_gate_clearances bound
        ON bound.tenant_id = gate.tenant_id
       AND bound.gate_id = gate.gate_id
       AND bound.from_gate_version + 1 = gate.version
       AND bound.to_state = gate.state
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate = 'Crew'
       AND gate.state = 'complete'
       AND bound.actor_kind = 'policy'
       AND bound.basis = 'crew_assignment'
       AND CASE WHEN json_valid(bound.evidence_refs_json) THEN
         json_extract(bound.evidence_refs_json, '$.crew_id') = NEW.crew_id
         AND json_extract(bound.evidence_refs_json, '$.crew_version') = NEW.crew_version
         AND (
           json_extract(bound.evidence_refs_json, '$.assignment_id') = NEW.assignment_id
           OR EXISTS (
             SELECT 1
               FROM operating_job_assignments earlier
              WHERE earlier.tenant_id = NEW.tenant_id
                AND earlier.roof_job_id = NEW.roof_job_id
                AND earlier.assignment_id = json_extract(bound.evidence_refs_json, '$.assignment_id')
           )
         )
       END
  );

  -- Deposit never stands on a contract with no deposit once the job's latest contract is another
  -- one with other terms: that is the window before the policy's `contract_superseded` entry lands.
  -- Only the latest contract counts, because only the latest is the one the policy acts on. A
  -- latest contract that again has no deposit and is paid on completion leaves Deposit standing,
  -- because the policy never re-binds one contract with no deposit to another.
  SELECT RAISE(ABORT, 'operating_job_assignment_deposit_contract_superseded')
  WHERE EXISTS (
    SELECT 1
      FROM operating_production_gates gate
      JOIN production_gate_clearances deposit
        ON deposit.tenant_id = gate.tenant_id
       AND deposit.gate_id = gate.gate_id
       AND deposit.from_gate_version + 1 = gate.version
       AND deposit.to_state = gate.state
      JOIN commercial_acceptance_bindings binding
        ON binding.tenant_id = deposit.tenant_id
       AND binding.acceptance_binding_id = deposit.contract_binding_id
      JOIN commercial_acceptance_bindings latest
        ON latest.tenant_id = binding.tenant_id
       AND latest.roof_job_id = binding.roof_job_id
       AND latest.acceptance_binding_id != binding.acceptance_binding_id
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings later
          WHERE later.tenant_id = latest.tenant_id
            AND later.roof_job_id = latest.roof_job_id
            AND (later.accepted_at > latest.accepted_at
                 OR (later.accepted_at = latest.accepted_at
                     AND later.acceptance_binding_id > latest.acceptance_binding_id))
       )
      LEFT JOIN commercial_quote_revisions quote
        ON quote.tenant_id = latest.tenant_id
       AND quote.quote_revision_id = latest.quote_revision_id
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate = 'Deposit'
       AND deposit.basis = 'contract_no_deposit'
       AND NOT (
         quote.quote_revision_id IS NOT NULL
         AND json_type(quote.terms_json, '$.deposit_percent') IS 'integer'
         AND json_extract(quote.terms_json, '$.deposit_percent') = 0
         AND json_type(quote.terms_json, '$.payment_schedule') IS 'array'
         AND json_array_length(quote.terms_json, '$.payment_schedule') = 1
         AND json_extract(quote.terms_json, '$.payment_schedule[0]') IS 'completion'
       )
  );

  -- Weather stands on a person's attestation, which names a work window. A Weather gate recorded
  -- before the ledger stands on a legacy entry that names none: it is refused as missing, never
  -- as ended, until a person attests Weather again. Weather has no waiver, so no other entry holds
  -- it open.
  SELECT RAISE(ABORT, 'operating_job_assignment_weather_window_missing')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
      JOIN production_gate_clearances weather
        ON weather.tenant_id = gate.tenant_id
       AND weather.gate_id = gate.gate_id
       AND weather.from_gate_version + 1 = gate.version
       AND weather.to_state = gate.state
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate = 'Weather'
       AND weather.basis = 'person_attestation'
       AND CASE WHEN json_valid(weather.attestation_json) THEN
         julianday(json_extract(weather.attestation_json, '$.window_start')) IS NOT NULL
         AND julianday(json_extract(weather.attestation_json, '$.window_end')) IS NOT NULL
       END
  );

  -- ... whose window has not ended by D1's clock. A Weather gate left `ready` after its window
  -- ended holds the work no longer.
  SELECT RAISE(ABORT, 'operating_job_assignment_weather_window_ended')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
      JOIN production_gate_clearances weather
        ON weather.tenant_id = gate.tenant_id
       AND weather.gate_id = gate.gate_id
       AND weather.from_gate_version + 1 = gate.version
       AND weather.to_state = gate.state
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate = 'Weather'
       AND weather.basis = 'person_attestation'
       AND julianday(json_extract(weather.attestation_json, '$.window_end')) > julianday('now')
  );

  -- ... and the scheduled work falls inside that window: the start and, when the schedule has
  -- one, the end. A schedule with no end is held to its start.
  SELECT RAISE(ABORT, 'operating_job_assignment_outside_weather_window')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
      JOIN production_gate_clearances weather
        ON weather.tenant_id = gate.tenant_id
       AND weather.gate_id = gate.gate_id
       AND weather.from_gate_version + 1 = gate.version
       AND weather.to_state = gate.state
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate = 'Weather'
       AND weather.basis = 'person_attestation'
       AND julianday(NEW.scheduled_start)
         >= julianday(json_extract(weather.attestation_json, '$.window_start'))
       AND julianday(COALESCE(NEW.scheduled_end, NEW.scheduled_start))
         <= julianday(json_extract(weather.attestation_json, '$.window_end'))
  );

  -- The crew is independent of the evidence: no active member of it shares a login coordinate
  -- (user id, email or Frappe user) with the person whose attestation Materials, Safety, Access or
  -- Weather stands on, compared as 0158 compares an attester with every crew.
  SELECT RAISE(ABORT, 'operating_job_assignment_crew_not_independent')
  WHERE EXISTS (
    SELECT 1
      FROM operating_production_gates gate
      JOIN production_gate_clearances attested
        ON attested.tenant_id = gate.tenant_id
       AND attested.gate_id = gate.gate_id
       AND attested.from_gate_version + 1 = gate.version
       AND attested.to_state = gate.state
      JOIN app_users attester
        ON attester.tenant_id = attested.tenant_id
       AND attester.user_id = attested.actor_user_id
      JOIN fleet_crew_members membership
        ON membership.tenant_id = NEW.tenant_id
       AND membership.crew_id = NEW.crew_id
       AND membership.active = 1
      JOIN app_users worker
        ON worker.tenant_id = membership.tenant_id
       AND worker.user_id = membership.user_id
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate IN ('Materials', 'Safety', 'Access', 'Weather')
       AND attested.basis = 'person_attestation'
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
END;

-- Preserve the predecessor firing order after each replaced production guard.
-- These following guards are recreated byte-for-byte: current principal/roster validation
-- and cancellation-window refusal still run before the same ledger evidence checks.

DROP TRIGGER production_gate_clearances_cancellation_window_hold;

CREATE TRIGGER production_gate_clearances_cancellation_window_hold
BEFORE INSERT ON production_gate_clearances
WHEN NEW.gate = 'Materials' AND NEW.entry_kind = 'clear'
BEGIN
  SELECT RAISE(ABORT, 'production_gate_cancellation_window_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
      JOIN contract_signed_copy_served served ON served.event_id = shown.event_id
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND shown.acceptance_binding_id = (
         SELECT contract.acceptance_binding_id
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = shown.tenant_id
            AND contract.roof_job_id = shown.roof_job_id
          ORDER BY contract.accepted_at DESC, contract.acceptance_binding_id DESC
          LIMIT 1
       )
  )
    AND NOT EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.roof_job_id = NEW.roof_job_id
       AND receipt.acceptance_binding_id IS (
         SELECT contract.acceptance_binding_id
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = receipt.tenant_id
            AND contract.roof_job_id = receipt.roof_job_id
          ORDER BY contract.accepted_at DESC, contract.acceptance_binding_id DESC
          LIMIT 1
       )
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
      JOIN contract_signed_copy_served served ON served.event_id = shown.event_id
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

DROP TRIGGER operating_job_assignments_cancellation_window_hold;

CREATE TRIGGER operating_job_assignments_cancellation_window_hold
BEFORE INSERT ON operating_job_assignments
BEGIN
  SELECT RAISE(ABORT, 'operating_job_assignment_cancellation_window_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM contract_signed_copy_events shown
      JOIN contract_signed_copy_served served ON served.event_id = shown.event_id
     WHERE shown.tenant_id = NEW.tenant_id
       AND shown.roof_job_id = NEW.roof_job_id
       AND shown.acceptance_binding_id = (
         SELECT contract.acceptance_binding_id
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = shown.tenant_id
            AND contract.roof_job_id = shown.roof_job_id
          ORDER BY contract.accepted_at DESC, contract.acceptance_binding_id DESC
          LIMIT 1
       )
  )
    AND NOT EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.roof_job_id = NEW.roof_job_id
       AND receipt.acceptance_binding_id IS (
         SELECT contract.acceptance_binding_id
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = receipt.tenant_id
            AND contract.roof_job_id = receipt.roof_job_id
          ORDER BY contract.accepted_at DESC, contract.acceptance_binding_id DESC
          LIMIT 1
       )
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
      JOIN contract_signed_copy_served served ON served.event_id = shown.event_id
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
