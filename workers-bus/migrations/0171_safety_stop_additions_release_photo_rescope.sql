-- 0171_safety_stop_additions_release_photo_rescope.sql - the second half of the P33 safety-stop
-- route gaps: adding to an open stop, the verified photo a release needs, vehicle stops that hold
-- their vehicle, and putting a stop on its job.
--
-- Which captures belong to a stop. A field capture counts for a stop when it is a verified,
-- manifested, stored Work Package capture of this tenant (as 0145/0152 define one) and its job is
-- one the stop holds: the stop's job for a `roof_job` stop, the job of any version of its package
-- for a `work_package` stop, and any job of the tenant for a stop whose job or package does not
-- exist, a tenant stop, a shop stop or a vehicle stop, which no job capture can be narrowed to.
--
-- 1. Additions. Any active person may add a note, verified photos, or both to a stop while it is
--    active. `safety_occurrence_additions` is append-only and its time is D1's clock. An addition
--    changes nothing on the stop.
--
-- 2. Release photo. A `released` event cites one to ten distinct captures that belong to the stop,
--    each with its stored checksum and each taken strictly after the stop was raised, compared as
--    instants. 0165 already lifts a stop only with that event, so no stop lifts without a verified
--    photo taken after it.
--
-- 3. Vehicle stops. An active `vehicle` stop holds the vehicle it names: no pre-trip inspection
--    (the crew app's record of taking a vehicle out), no cargo load that puts it on the road as the
--    vehicle or the trailer, and no custody handed to a person or crew. A post-trip inspection, a
--    defect report and a return to the yard stay open. A shop stop holding shop runs is a contract
--    rule only: no shop-run write exists yet.
--
-- 4. Re-scope. An owner or ops person may put an active stop that names a job or Work Package this
--    tenant does not have onto the job or package it meant, as an in-place correction recorded in
--    `safety_occurrence_rescopes` (append-only, D1's clock). The occurrence keeps its id, raiser,
--    state, stop and history; only its scope and version move. 0047's identity guard is re-created
--    with every clause unchanged except that a scope change is admitted when, and only when, that
--    exact correction is already recorded for the version the occurrence moves to and nothing else
--    about the stop changes. Triggers on one table fire newest first, so the re-created guard now
--    fires before 0165's release guard; the two never refuse the same single change differently
--    except for a direct write that is both a lift by the raiser and illegal for 0047, which now
--    reports 0047's code first.
--
-- Adds two tables, two indexes and thirteen triggers, and re-creates one trigger.

-- 1. Additions -------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS safety_occurrence_additions (
  addition_id TEXT PRIMARY KEY CHECK (
    length(addition_id) = 36 AND addition_id GLOB 'soa_*' AND substr(addition_id, 5) NOT GLOB '*[^0-9a-f]*'
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
  added_by_user_id TEXT NOT NULL,
  added_by_role TEXT NOT NULL CHECK (length(added_by_role) BETWEEN 3 AND 32),
  note TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 3 AND 4000),
  evidence_refs_json TEXT CHECK (evidence_refs_json IS NULL OR length(evidence_refs_json) BETWEEN 2 AND 20000),
  added_at TEXT NOT NULL CHECK (length(added_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (note IS NOT NULL OR evidence_refs_json IS NOT NULL),
  FOREIGN KEY (occurrence_id, tenant_id)
    REFERENCES safety_occurrences(occurrence_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (added_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_safety_occurrence_additions_occurrence
  ON safety_occurrence_additions (tenant_id, occurrence_id, added_at DESC);

CREATE TRIGGER safety_occurrence_additions_validate_insert
BEFORE INSERT ON safety_occurrence_additions
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.added_by_user_id
       AND actor.active = 1
       AND COALESCE(actor.access_role, actor.role) = NEW.added_by_role
  );

  SELECT RAISE(ABORT, 'safety_stop_not_open')
  WHERE NOT EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND occurrence.stop_active = 1
  );

  -- One to ten distinct references, each exactly one verified, stored capture that belongs to the
  -- stop, with the checksum of the stored object.
  SELECT RAISE(ABORT, 'safety_stop_addition_evidence_invalid')
  WHERE NEW.evidence_refs_json IS NOT NULL
    AND (
      json_valid(NEW.evidence_refs_json) IS NOT 1
      OR json_type(NEW.evidence_refs_json) IS NOT 'array'
      OR json_array_length(NEW.evidence_refs_json) NOT BETWEEN 1 AND 10
      OR (
        SELECT COUNT(DISTINCT json_extract(NEW.evidence_refs_json, item.fullkey || '.ref'))
          FROM json_each(NEW.evidence_refs_json) item
      ) != json_array_length(NEW.evidence_refs_json)
      OR EXISTS (
        SELECT 1
          FROM json_each(NEW.evidence_refs_json) item
         WHERE item.type IS NOT 'object'
            OR (SELECT COUNT(*) FROM json_each(NEW.evidence_refs_json, item.fullkey)) != 2
            OR json_type(NEW.evidence_refs_json, item.fullkey || '.ref') IS NOT 'text'
            OR json_type(NEW.evidence_refs_json, item.fullkey || '.sha256') IS NOT 'text'
            OR (
              SELECT COUNT(*)
                FROM field_actions capture
                JOIN field_action_media media ON media.device_action_id = capture.device_action_id
                JOIN safety_occurrences occurrence
                  ON occurrence.tenant_id = NEW.tenant_id
                 AND occurrence.occurrence_id = NEW.occurrence_id
               WHERE capture.tenant_id = NEW.tenant_id
                 AND capture.work_package_id IS NOT NULL
                 AND capture.status = 'verified'
                 AND capture.manifest_key IS NOT NULL
                 AND capture.evidence_verification = 'Verified'
                 AND media.r2_stored_at IS NOT NULL
                 AND 'field-evidence://' || media.evidence_id
                   = json_extract(NEW.evidence_refs_json, item.fullkey || '.ref')
                 AND media.checksum_sha256
                   = json_extract(NEW.evidence_refs_json, item.fullkey || '.sha256')
                 AND (
                   occurrence.scope_type NOT IN ('roof_job', 'work_package')
                   OR (occurrence.scope_type = 'roof_job' AND (
                     capture.job_id = occurrence.scope_id
                     OR NOT EXISTS (
                       SELECT 1 FROM operating_roof_jobs job
                        WHERE job.tenant_id = occurrence.tenant_id
                          AND job.roof_job_id = occurrence.scope_id
                     )
                   ))
                   OR (occurrence.scope_type = 'work_package' AND (
                     capture.job_id IN (
                       SELECT package.job_id FROM work_packages package
                        WHERE package.tenant_id = occurrence.tenant_id
                          AND package.work_package_id = occurrence.scope_id
                     )
                     OR NOT EXISTS (
                       SELECT 1 FROM work_packages package
                        WHERE package.tenant_id = occurrence.tenant_id
                          AND package.work_package_id = occurrence.scope_id
                     )
                   ))
                 )
            ) != 1
      )
    );

  -- When it was added is D1's clock, not the caller's.
  SELECT RAISE(ABORT, 'safety_stop_addition_clock_invalid')
  WHERE NEW.added_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER safety_occurrence_additions_no_insert_replace
BEFORE INSERT ON safety_occurrence_additions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_addition_append_only')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrence_additions existing
     WHERE existing.addition_id = NEW.addition_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.idempotency_key = NEW.idempotency_key)
  );
END;

CREATE TRIGGER safety_occurrence_additions_append_only_update
BEFORE UPDATE ON safety_occurrence_additions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_addition_append_only');
END;

CREATE TRIGGER safety_occurrence_additions_append_only_delete
BEFORE DELETE ON safety_occurrence_additions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_addition_retained');
END;

-- 2. Release photo ---------------------------------------------------------------------------------

CREATE TRIGGER safety_occurrence_events_release_evidence
BEFORE INSERT ON safety_occurrence_events
WHEN NEW.event_kind = 'released'
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_release_evidence_required')
  WHERE NEW.evidence_refs_json IS NULL;

  SELECT RAISE(ABORT, 'safety_stop_release_evidence_invalid')
  WHERE json_valid(NEW.evidence_refs_json) IS NOT 1
     OR json_type(NEW.evidence_refs_json) IS NOT 'array'
     OR json_array_length(NEW.evidence_refs_json) NOT BETWEEN 1 AND 10
     OR (
       SELECT COUNT(DISTINCT json_extract(NEW.evidence_refs_json, item.fullkey || '.ref'))
         FROM json_each(NEW.evidence_refs_json) item
     ) != json_array_length(NEW.evidence_refs_json)
     OR EXISTS (
       SELECT 1
         FROM json_each(NEW.evidence_refs_json) item
        WHERE item.type IS NOT 'object'
           OR (SELECT COUNT(*) FROM json_each(NEW.evidence_refs_json, item.fullkey)) != 2
           OR json_type(NEW.evidence_refs_json, item.fullkey || '.ref') IS NOT 'text'
           OR json_type(NEW.evidence_refs_json, item.fullkey || '.sha256') IS NOT 'text'
           OR (
             SELECT COUNT(*)
               FROM field_actions capture
               JOIN field_action_media media ON media.device_action_id = capture.device_action_id
               JOIN safety_occurrences occurrence
                 ON occurrence.tenant_id = NEW.tenant_id
                AND occurrence.occurrence_id = NEW.occurrence_id
              WHERE capture.tenant_id = NEW.tenant_id
                AND capture.work_package_id IS NOT NULL
                AND capture.status = 'verified'
                AND capture.manifest_key IS NOT NULL
                AND capture.evidence_verification = 'Verified'
                AND media.r2_stored_at IS NOT NULL
                AND 'field-evidence://' || media.evidence_id
                  = json_extract(NEW.evidence_refs_json, item.fullkey || '.ref')
                AND media.checksum_sha256
                  = json_extract(NEW.evidence_refs_json, item.fullkey || '.sha256')
                AND (
                  occurrence.scope_type NOT IN ('roof_job', 'work_package')
                  OR (occurrence.scope_type = 'roof_job' AND (
                    capture.job_id = occurrence.scope_id
                    OR NOT EXISTS (
                      SELECT 1 FROM operating_roof_jobs job
                       WHERE job.tenant_id = occurrence.tenant_id
                         AND job.roof_job_id = occurrence.scope_id
                    )
                  ))
                  OR (occurrence.scope_type = 'work_package' AND (
                    capture.job_id IN (
                      SELECT package.job_id FROM work_packages package
                       WHERE package.tenant_id = occurrence.tenant_id
                         AND package.work_package_id = occurrence.scope_id
                    )
                    OR NOT EXISTS (
                      SELECT 1 FROM work_packages package
                       WHERE package.tenant_id = occurrence.tenant_id
                         AND package.work_package_id = occurrence.scope_id
                    )
                  ))
                )
           ) != 1
     );

  -- Each cited capture was taken strictly after the stop was raised: a photo from before the stop
  -- shows what the crew stopped on, never the fix.
  SELECT RAISE(ABORT, 'safety_stop_release_evidence_before_stop')
  WHERE EXISTS (
    SELECT 1
      FROM json_each(NEW.evidence_refs_json) item
      JOIN safety_occurrences occurrence
        ON occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
     WHERE NOT EXISTS (
       SELECT 1
         FROM field_actions capture
         JOIN field_action_media media ON media.device_action_id = capture.device_action_id
        WHERE capture.tenant_id = NEW.tenant_id
          AND 'field-evidence://' || media.evidence_id
            = json_extract(NEW.evidence_refs_json, item.fullkey || '.ref')
          AND media.checksum_sha256
            = json_extract(NEW.evidence_refs_json, item.fullkey || '.sha256')
          AND julianday(COALESCE(capture.capture_completed_at, capture.created_at))
            > julianday(occurrence.reported_at)
     )
  );
END;

-- 3. Vehicle stops ---------------------------------------------------------------------------------

CREATE TRIGGER fleet_inspections_vehicle_stop_guard
BEFORE INSERT ON fleet_inspections
WHEN NEW.inspection_type = 'Pre-Trip'
BEGIN
  SELECT RAISE(ABORT, 'fleet_vehicle_safety_stop_active')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.stop_active = 1
       AND occurrence.scope_type = 'vehicle'
       AND occurrence.scope_id = NEW.fleet_asset_id
  );
END;

CREATE TRIGGER fleet_cargo_loads_vehicle_stop_insert_guard
BEFORE INSERT ON fleet_cargo_loads
WHEN NEW.status IN ('Loaded', 'In Transit')
BEGIN
  SELECT RAISE(ABORT, 'fleet_vehicle_safety_stop_active')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.stop_active = 1
       AND occurrence.scope_type = 'vehicle'
       AND occurrence.scope_id IN (NEW.fleet_asset_id, NEW.trailer_asset_id)
  );
END;

CREATE TRIGGER fleet_cargo_loads_vehicle_stop_update_guard
BEFORE UPDATE ON fleet_cargo_loads
WHEN NEW.status IN ('Loaded', 'In Transit')
  AND (
    OLD.status NOT IN ('Loaded', 'In Transit')
    OR NEW.fleet_asset_id IS NOT OLD.fleet_asset_id
    OR NEW.trailer_asset_id IS NOT OLD.trailer_asset_id
  )
BEGIN
  SELECT RAISE(ABORT, 'fleet_vehicle_safety_stop_active')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.stop_active = 1
       AND occurrence.scope_type = 'vehicle'
       AND occurrence.scope_id IN (NEW.fleet_asset_id, NEW.trailer_asset_id)
  );
END;

CREATE TRIGGER fleet_assets_vehicle_stop_custody_guard
BEFORE UPDATE OF custody_holder_type, custody_user_id, custody_crew_id ON fleet_assets
WHEN NEW.custody_holder_type IN ('User', 'Crew')
  AND (
    NEW.custody_holder_type IS NOT OLD.custody_holder_type
    OR NEW.custody_user_id IS NOT OLD.custody_user_id
    OR NEW.custody_crew_id IS NOT OLD.custody_crew_id
  )
BEGIN
  SELECT RAISE(ABORT, 'fleet_vehicle_safety_stop_active')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.stop_active = 1
       AND occurrence.scope_type = 'vehicle'
       AND occurrence.scope_id = NEW.fleet_asset_id
  );
END;

-- 4. Re-scope --------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS safety_occurrence_rescopes (
  rescope_id TEXT PRIMARY KEY CHECK (
    length(rescope_id) = 36 AND rescope_id GLOB 'sor_*' AND substr(rescope_id, 5) NOT GLOB '*[^0-9a-f]*'
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
  from_version INTEGER NOT NULL CHECK (from_version BETWEEN 1 AND 999999),
  to_version INTEGER NOT NULL CHECK (to_version = from_version + 1),
  from_scope_type TEXT NOT NULL CHECK (from_scope_type IN ('roof_job', 'work_package')),
  from_scope_id TEXT NOT NULL CHECK (length(from_scope_id) BETWEEN 1 AND 140),
  to_scope_type TEXT NOT NULL CHECK (to_scope_type IN ('roof_job', 'work_package')),
  to_scope_id TEXT NOT NULL CHECK (
    length(to_scope_id) BETWEEN 1 AND 140
    AND to_scope_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  moved_by_user_id TEXT NOT NULL,
  moved_by_role TEXT NOT NULL CHECK (moved_by_role IN ('owner', 'ops')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 4000),
  moved_at TEXT NOT NULL CHECK (length(moved_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, occurrence_id, to_version),
  FOREIGN KEY (occurrence_id, tenant_id)
    REFERENCES safety_occurrences(occurrence_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (moved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_safety_occurrence_rescopes_occurrence
  ON safety_occurrence_rescopes (tenant_id, occurrence_id, to_version DESC);

CREATE TRIGGER safety_occurrence_rescopes_validate_insert
BEFORE INSERT ON safety_occurrence_rescopes
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.moved_by_user_id
       AND actor.active = 1
       AND COALESCE(actor.access_role, actor.role) = NEW.moved_by_role
  );

  SELECT RAISE(ABORT, 'safety_occurrence_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND occurrence.version = NEW.from_version
       AND occurrence.scope_type = NEW.from_scope_type
       AND occurrence.scope_id = NEW.from_scope_id
  );

  -- A correction, never a release: only an active stop is moved, and it stays active.
  SELECT RAISE(ABORT, 'safety_stop_already_released')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND occurrence.stop_active != 1
  );

  -- Only a stop whose job or Work Package does not exist is moved.
  SELECT RAISE(ABORT, 'safety_stop_scope_resolved')
  WHERE (NEW.from_scope_type = 'roof_job' AND EXISTS (
          SELECT 1 FROM operating_roof_jobs job
           WHERE job.tenant_id = NEW.tenant_id AND job.roof_job_id = NEW.from_scope_id
        ))
     OR (NEW.from_scope_type = 'work_package' AND EXISTS (
          SELECT 1 FROM work_packages package
           WHERE package.tenant_id = NEW.tenant_id AND package.work_package_id = NEW.from_scope_id
        ));

  -- And only onto a job or Work Package this tenant has.
  SELECT RAISE(ABORT, 'safety_stop_scope_target_unknown')
  WHERE (NEW.to_scope_type = 'roof_job' AND NOT EXISTS (
          SELECT 1 FROM operating_roof_jobs job
           WHERE job.tenant_id = NEW.tenant_id AND job.roof_job_id = NEW.to_scope_id
        ))
     OR (NEW.to_scope_type = 'work_package' AND NOT EXISTS (
          SELECT 1 FROM work_packages package
           WHERE package.tenant_id = NEW.tenant_id AND package.work_package_id = NEW.to_scope_id
        ));

  -- When it was moved is D1's clock, not the caller's.
  SELECT RAISE(ABORT, 'safety_stop_rescope_clock_invalid')
  WHERE NEW.moved_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER safety_occurrence_rescopes_no_insert_replace
BEFORE INSERT ON safety_occurrence_rescopes
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_rescope_append_only')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrence_rescopes existing
     WHERE existing.rescope_id = NEW.rescope_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.idempotency_key = NEW.idempotency_key)
        OR (existing.tenant_id = NEW.tenant_id AND existing.occurrence_id = NEW.occurrence_id
            AND existing.to_version = NEW.to_version)
  );
END;

CREATE TRIGGER safety_occurrence_rescopes_append_only_update
BEFORE UPDATE ON safety_occurrence_rescopes
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_rescope_append_only');
END;

CREATE TRIGGER safety_occurrence_rescopes_append_only_delete
BEFORE DELETE ON safety_occurrence_rescopes
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_rescope_retained');
END;

-- 0047's identity guard, every clause unchanged except the scope: a scope change stands only on the
-- recorded correction for exactly this move, with nothing else about the stop changing.
DROP TRIGGER safety_occurrences_identity_immutable;

CREATE TRIGGER safety_occurrences_identity_immutable
BEFORE UPDATE ON safety_occurrences
BEGIN
  SELECT RAISE(ABORT, 'safety_occurrence_identity_immutable')
  WHERE NEW.occurrence_id != OLD.occurrence_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.occurrence_kind != OLD.occurrence_kind
     OR NEW.reported_by_user_id != OLD.reported_by_user_id
     OR NEW.reported_at != OLD.reported_at
     OR NEW.summary != OLD.summary
     OR NEW.report_fingerprint_sha256 != OLD.report_fingerprint_sha256
     OR NEW.created_at != OLD.created_at
     OR ((NEW.scope_type != OLD.scope_type OR NEW.scope_id != OLD.scope_id)
         AND NOT (
           NEW.stop_active = 1 AND OLD.stop_active = 1
           AND NEW.state = OLD.state
           AND NEW.severity = OLD.severity
           AND NEW.rescue_required = OLD.rescue_required
           AND NEW.rescue_completed_at IS OLD.rescue_completed_at
           AND NEW.closed_at IS OLD.closed_at
           AND NEW.released_by_user_id IS OLD.released_by_user_id
           AND EXISTS (
             SELECT 1 FROM safety_occurrence_rescopes rescope
              WHERE rescope.tenant_id = NEW.tenant_id
                AND rescope.occurrence_id = NEW.occurrence_id
                AND rescope.from_version = OLD.version
                AND rescope.to_version = NEW.version
                AND rescope.from_scope_type = OLD.scope_type
                AND rescope.from_scope_id = OLD.scope_id
                AND rescope.to_scope_type = NEW.scope_type
                AND rescope.to_scope_id = NEW.scope_id
           )
         ));

  SELECT RAISE(ABORT, 'safety_occurrence_version_must_advance')
  WHERE NEW.version != OLD.version + 1;

  SELECT RAISE(ABORT, 'safety_occurrence_state_invalid')
  WHERE OLD.state = 'closed'
     OR (OLD.state = 'reported' AND NEW.state NOT IN ('reported', 'made_safe'))
     OR (OLD.state = 'made_safe' AND NEW.state NOT IN ('made_safe', 'investigating'))
     OR (OLD.state = 'investigating' AND NEW.state NOT IN ('investigating', 'controlled'))
     OR (OLD.state = 'controlled' AND NEW.state NOT IN ('controlled', 'closed'));

  -- Severity may be raised by new facts but never quietly lowered.
  SELECT RAISE(ABORT, 'safety_occurrence_severity_downgrade_forbidden')
  WHERE (SELECT COUNT(*) FROM (
      SELECT 1 WHERE OLD.severity = 'critical' AND NEW.severity != 'critical'
      UNION ALL
      SELECT 1 WHERE OLD.severity = 'high' AND NEW.severity NOT IN ('high', 'critical')
      UNION ALL
      SELECT 1 WHERE OLD.severity = 'moderate' AND NEW.severity = 'low'
    )) > 0;

  -- A stop cannot be lifted while the event is uncontrolled or a required
  -- rescue has not completed.
  SELECT RAISE(ABORT, 'safety_stop_release_not_permitted')
  WHERE OLD.stop_active = 1 AND NEW.stop_active = 0
    AND (NEW.state NOT IN ('controlled', 'closed')
         OR (NEW.rescue_required = 1 AND NEW.rescue_completed_at IS NULL));

  SELECT RAISE(ABORT, 'safety_stop_reactivation_forbidden')
  WHERE OLD.stop_active = 0 AND NEW.stop_active = 1;
END;
