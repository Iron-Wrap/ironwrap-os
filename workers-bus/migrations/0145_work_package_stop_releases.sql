-- 0145_work_package_stop_releases.sql - a person releases one crew stop on one exact Work Package
-- version.
--
-- A crew stop (`stop_work`, 0094) moves a package version to Blocked, and 0143 refuses every status
-- change away from Blocked and every supersession of a Blocked version. This append-only record is
-- the only fact that releases one stop. It names the exact Blocked version, the stop event and
-- device action it resolves, who raised the stop and who is on its receipt, the person who released
-- it and the role they held at that moment, the independence facts, the cited correction evidence
-- and the reason. Inserting it restores, in the same statement, the status the stop interrupted,
-- which is the state office reissue accepts.
--
-- Releasing a safety stop is people-only (`safety_stop.release`, class H): the Worker admits a
-- release only from a person's own cookie session. This table repeats what the database can see:
-- an active owner, ops or production user under their current role, who shares no identity with
-- the stop's actor or the user on its receipt, citing verified, manifested, stored Work Package
-- evidence of the same tenant and job, with the stored checksum.

CREATE TABLE IF NOT EXISTS work_package_stop_releases (
  release_id TEXT PRIMARY KEY CHECK (
    length(release_id) = 36
    AND substr(release_id, 1, 4) = 'wsr_'
    AND substr(release_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  device_action_id TEXT NOT NULL CHECK (
    length(device_action_id) BETWEEN 8 AND 140
    AND device_action_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  work_package_id TEXT NOT NULL,
  work_package_version INTEGER NOT NULL CHECK (work_package_version BETWEEN 1 AND 1000000),
  job_id TEXT NOT NULL CHECK (length(trim(job_id)) BETWEEN 1 AND 140),
  stop_event_id TEXT NOT NULL,
  stop_device_action_id TEXT NOT NULL CHECK (length(trim(stop_device_action_id)) BETWEEN 8 AND 80),
  stop_actor_user_id TEXT NOT NULL CHECK (length(trim(stop_actor_user_id)) BETWEEN 1 AND 140),
  stop_reporter_user_id TEXT CHECK (
    stop_reporter_user_id IS NULL OR length(trim(stop_reporter_user_id)) BETWEEN 1 AND 140
  ),
  restored_status TEXT NOT NULL CHECK (
    restored_status IN ('Released', 'Acknowledged', 'In Progress')
  ),
  released_by_user_id TEXT NOT NULL,
  released_by_role TEXT NOT NULL CHECK (released_by_role IN ('owner', 'ops', 'production')),
  independence_json TEXT NOT NULL CHECK (
    json_valid(independence_json) AND length(independence_json) <= 2000
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    json_valid(evidence_refs_json) AND length(evidence_refs_json) <= 4000
  ),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 4000),
  manifest_key TEXT NOT NULL CHECK (length(trim(manifest_key)) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, device_action_id),
  UNIQUE (tenant_id, stop_event_id),
  FOREIGN KEY (work_package_id, tenant_id, work_package_version)
    REFERENCES work_packages(work_package_id, tenant_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (stop_event_id)
    REFERENCES work_package_events(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (released_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_work_package_stop_releases_package
  ON work_package_stop_releases (tenant_id, work_package_id, work_package_version, created_at);

CREATE TRIGGER work_package_stop_releases_validate_insert
BEFORE INSERT ON work_package_stop_releases
BEGIN
  -- The package version and its job belong to this tenant and the version is Blocked. The named
  -- stop is a stop event on that exact version, and every other stop on the version already has
  -- its own release, so the named stop is the one holding it. The recorded reporter is exactly the
  -- user on the stop's receipt, and none without one.
  SELECT RAISE(ABORT, 'work_package_stop_release_scope_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM work_packages package
      JOIN work_package_events stop
        ON stop.tenant_id = package.tenant_id
       AND stop.work_package_id = package.work_package_id
       AND stop.work_package_version = package.version
     WHERE package.tenant_id = NEW.tenant_id
       AND package.work_package_id = NEW.work_package_id
       AND package.version = NEW.work_package_version
       AND package.job_id = NEW.job_id
       AND package.status = 'Blocked'
       AND stop.event_id = NEW.stop_event_id
       AND stop.event_kind = 'stop_work'
       AND stop.device_action_id = NEW.stop_device_action_id
       AND stop.actor_user_id = NEW.stop_actor_user_id
       AND stop.occurred_at <= NEW.created_at
  )
  OR EXISTS (
    SELECT 1
      FROM work_package_events other
     WHERE other.tenant_id = NEW.tenant_id
       AND other.work_package_id = NEW.work_package_id
       AND other.work_package_version = NEW.work_package_version
       AND other.event_kind = 'stop_work'
       AND other.event_id != NEW.stop_event_id
       AND NOT EXISTS (
         SELECT 1
           FROM work_package_stop_releases released
          WHERE released.tenant_id = other.tenant_id
            AND released.stop_event_id = other.event_id
       )
  )
  OR NEW.stop_reporter_user_id IS NOT (
    SELECT receipt.user_id
      FROM field_work_package_actions receipt
     WHERE receipt.tenant_id = NEW.tenant_id
       AND receipt.device_action_id = NEW.stop_device_action_id
       AND receipt.work_package_id = NEW.work_package_id
       AND receipt.action_kind = 'stop_work'
  );

  -- A release returns the version to exactly the status the stop interrupted, read from the
  -- version's own event ledger.
  SELECT RAISE(ABORT, 'work_package_stop_release_status_invalid')
  WHERE NEW.restored_status IS NOT (
    SELECT CASE
      WHEN EXISTS (
        SELECT 1 FROM work_package_events started
         WHERE started.tenant_id = NEW.tenant_id
           AND started.work_package_id = NEW.work_package_id
           AND started.work_package_version = NEW.work_package_version
           AND started.event_kind = 'start_work'
      ) THEN 'In Progress'
      WHEN EXISTS (
        SELECT 1 FROM work_package_events acknowledged
         WHERE acknowledged.tenant_id = NEW.tenant_id
           AND acknowledged.work_package_id = NEW.work_package_id
           AND acknowledged.work_package_version = NEW.work_package_version
           AND acknowledged.event_kind = 'acknowledged'
      ) THEN 'Acknowledged'
      ELSE 'Released'
    END
  );

  -- The releaser is an active user of this tenant and holds the recorded role right now.
  SELECT RAISE(ABORT, 'work_package_stop_release_actor_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.released_by_user_id
       AND actor.active = 1
       AND actor.access_role = NEW.released_by_role
  );

  -- Never the person who raised the stop or the user on its receipt, under any identity either of
  -- them carries, and the recorded independence facts say exactly that.
  SELECT RAISE(ABORT, 'work_package_stop_release_independence_required')
  WHERE EXISTS (
    SELECT 1
      FROM app_users releaser
     WHERE releaser.tenant_id = NEW.tenant_id
       AND releaser.user_id = NEW.released_by_user_id
       AND (
         lower(trim(NEW.stop_actor_user_id)) IN (
           lower(releaser.user_id), releaser.email_normalized, lower(trim(releaser.frappe_user_id))
         )
         OR lower(trim(NEW.stop_reporter_user_id)) IN (
           lower(releaser.user_id), releaser.email_normalized, lower(trim(releaser.frappe_user_id))
         )
         OR EXISTS (
           SELECT 1
             FROM app_users stopper
            WHERE stopper.tenant_id = NEW.tenant_id
              AND stopper.user_id IN (NEW.stop_actor_user_id, NEW.stop_reporter_user_id)
              AND (
                lower(stopper.user_id) IN (
                  lower(releaser.user_id), releaser.email_normalized,
                  lower(trim(releaser.frappe_user_id))
                )
                OR stopper.email_normalized IN (
                  lower(releaser.user_id), releaser.email_normalized,
                  lower(trim(releaser.frappe_user_id))
                )
                OR lower(trim(stopper.frappe_user_id)) IN (
                  lower(releaser.user_id), releaser.email_normalized,
                  lower(trim(releaser.frappe_user_id))
                )
              )
         )
       )
  )
  OR json_type(NEW.independence_json) IS NOT 'object'
  OR (SELECT COUNT(*) FROM json_each(NEW.independence_json)) != 3
  OR json_type(NEW.independence_json, '$.released_by_is_stop_actor') IS NOT 'false'
  OR json_type(NEW.independence_json, '$.released_by_is_stop_reporter') IS NOT 'false'
  OR json_type(NEW.independence_json, '$.released_in_person_session') IS NOT 'true';

  -- One to ten distinct references, each exactly one verified, manifested, stored Work Package
  -- capture of this tenant and this job, with the checksum of the stored object.
  SELECT RAISE(ABORT, 'work_package_stop_release_evidence_invalid')
  WHERE json_type(NEW.evidence_refs_json) IS NOT 'array'
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
              WHERE capture.tenant_id = NEW.tenant_id
                AND capture.job_id = NEW.job_id
                AND capture.work_package_id IS NOT NULL
                AND capture.status = 'verified'
                AND capture.manifest_key IS NOT NULL
                AND capture.evidence_verification = 'Verified'
                AND media.r2_stored_at IS NOT NULL
                AND 'field-evidence://' || media.evidence_id
                  = json_extract(NEW.evidence_refs_json, item.fullkey || '.ref')
                AND media.checksum_sha256
                  = json_extract(NEW.evidence_refs_json, item.fullkey || '.sha256')
           ) != 1
     );
END;

-- Same statement as the insert: the release and the restored status commit or fail together.
CREATE TRIGGER work_package_stop_releases_apply
AFTER INSERT ON work_package_stop_releases
BEGIN
  UPDATE work_packages
     SET status = NEW.restored_status, updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id
     AND work_package_id = NEW.work_package_id
     AND version = NEW.work_package_version
     AND status = 'Blocked';
END;

CREATE TRIGGER work_package_stop_releases_append_only_update
BEFORE UPDATE ON work_package_stop_releases
BEGIN
  SELECT RAISE(ABORT, 'work_package_stop_release_append_only');
END;

CREATE TRIGGER work_package_stop_releases_append_only_delete
BEFORE DELETE ON work_package_stop_releases
BEGIN
  SELECT RAISE(ABORT, 'work_package_stop_release_append_only');
END;

-- REPLACE would delete an earlier release before inserting; refuse any conflicting key first.
CREATE TRIGGER work_package_stop_releases_no_insert_replace
BEFORE INSERT ON work_package_stop_releases
BEGIN
  SELECT RAISE(ABORT, 'work_package_stop_release_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM work_package_stop_releases existing
     WHERE existing.release_id = NEW.release_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.device_action_id = NEW.device_action_id)
  );
  SELECT RAISE(ABORT, 'work_package_stop_already_released')
  WHERE EXISTS (
    SELECT 1
      FROM work_package_stop_releases existing
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.stop_event_id = NEW.stop_event_id
  );
END;

-- 0096's projection guard, every clause unchanged, plus one more fact that may move a version:
-- a release of that exact Blocked version recorded at the same instant for the same status. A
-- release only ever restores a status, so it can never stand in for a supersession or a ledger
-- event. Re-created before the two 0143 guards so that, firing newest first, the stop guard still
-- answers first for a stopped version.
DROP TRIGGER work_packages_projection_guard;

CREATE TRIGGER work_packages_projection_guard
BEFORE UPDATE ON work_packages
BEGIN
  SELECT RAISE(ABORT, 'work_package_definition_immutable')
  WHERE NEW.work_package_id IS NOT OLD.work_package_id
     OR NEW.tenant_id IS NOT OLD.tenant_id
     OR NEW.version IS NOT OLD.version
     OR NEW.job_id IS NOT OLD.job_id
     OR NEW.assignment_id IS NOT OLD.assignment_id
     OR NEW.work_object_type IS NOT OLD.work_object_type
     OR NEW.work_object_id IS NOT OLD.work_object_id
     OR NEW.physical_context_type IS NOT OLD.physical_context_type
     OR NEW.physical_context_id IS NOT OLD.physical_context_id
     OR NEW.assignment_authority_user IS NOT OLD.assignment_authority_user
     OR NEW.assignment_authority_role IS NOT OLD.assignment_authority_role
     OR NEW.title IS NOT OLD.title
     OR NEW.objective IS NOT OLD.objective
     OR NEW.boundaries IS NOT OLD.boundaries
     OR NEW.prerequisites IS NOT OLD.prerequisites
     OR NEW.expected_result IS NOT OLD.expected_result
     OR NEW.stop_conditions IS NOT OLD.stop_conditions
     OR NEW.make_safe_procedure IS NOT OLD.make_safe_procedure
     OR NEW.definition_json IS NOT OLD.definition_json
     OR NEW.issued_at IS NOT OLD.issued_at
     OR NEW.expires_at IS NOT OLD.expires_at
     OR NEW.released_at IS NOT OLD.released_at
     OR NEW.release_attempt_id IS NOT OLD.release_attempt_id
     OR NEW.supersedes_id IS NOT OLD.supersedes_id
     OR NEW.correction_reason IS NOT OLD.correction_reason
     OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'work_package_projection_without_fact')
  WHERE NOT (
    NEW.status = 'Superseded'
    AND NEW.acknowledged_at IS OLD.acknowledged_at
    AND NEW.completed_at IS OLD.completed_at
    AND EXISTS (
      SELECT 1
        FROM work_package_supersessions replacement
       WHERE replacement.tenant_id = OLD.tenant_id
         AND replacement.prior_work_package_id = OLD.work_package_id
         AND replacement.prior_work_package_version = OLD.version
         AND replacement.occurred_at = NEW.updated_at
    )
  ) AND NOT (
    OLD.status = 'Blocked'
    AND NEW.acknowledged_at IS OLD.acknowledged_at
    AND NEW.completed_at IS OLD.completed_at
    AND EXISTS (
      SELECT 1
        FROM work_package_stop_releases released
       WHERE released.tenant_id = OLD.tenant_id
         AND released.work_package_id = OLD.work_package_id
         AND released.work_package_version = OLD.version
         AND released.restored_status = NEW.status
         AND released.created_at = NEW.updated_at
    )
  ) AND NOT EXISTS (
    SELECT 1
      FROM work_package_events event
     WHERE event.tenant_id = OLD.tenant_id
       AND event.work_package_id = OLD.work_package_id
       AND event.work_package_version = OLD.version
       AND event.occurred_at = NEW.updated_at
       AND NEW.status = CASE event.event_kind
         WHEN 'acknowledged' THEN CASE WHEN OLD.status = 'Released' THEN 'Acknowledged' ELSE OLD.status END
         WHEN 'start_work' THEN 'In Progress'
         WHEN 'stop_work' THEN 'Blocked'
         WHEN 'complete_work' THEN 'Completed'
         ELSE OLD.status
       END
       AND NEW.acknowledged_at IS CASE
         WHEN event.event_kind = 'acknowledged' THEN COALESCE(OLD.acknowledged_at, event.occurred_at)
         ELSE OLD.acknowledged_at
       END
       AND NEW.completed_at IS CASE
         WHEN event.event_kind = 'complete_work' THEN event.occurred_at
         ELSE OLD.completed_at
       END
  );
END;

-- 0143's guards keep their names, triggers and abort message. A supersession of a Blocked version,
-- or any status change away from Blocked, now passes only when this tenant holds a release for
-- that exact package version and no stop on the version is left without its own release: a
-- release for another version, or for an earlier stop on the same version, unlocks nothing.
DROP TRIGGER work_package_supersessions_blocked_guard;

CREATE TRIGGER work_package_supersessions_blocked_guard
BEFORE INSERT ON work_package_supersessions
WHEN EXISTS (
  SELECT 1 FROM work_packages prior
   WHERE prior.tenant_id = NEW.tenant_id
     AND prior.work_package_id = NEW.prior_work_package_id
     AND prior.version = NEW.prior_work_package_version
     AND prior.status = 'Blocked'
)
BEGIN
  SELECT RAISE(ABORT, 'work_package_stop_release_required')
  WHERE NOT EXISTS (
    SELECT 1
      FROM work_package_stop_releases released
     WHERE released.tenant_id = NEW.tenant_id
       AND released.work_package_id = NEW.prior_work_package_id
       AND released.work_package_version = NEW.prior_work_package_version
  )
  OR EXISTS (
    SELECT 1
      FROM work_package_events stop
     WHERE stop.tenant_id = NEW.tenant_id
       AND stop.work_package_id = NEW.prior_work_package_id
       AND stop.work_package_version = NEW.prior_work_package_version
       AND stop.event_kind = 'stop_work'
       AND NOT EXISTS (
         SELECT 1
           FROM work_package_stop_releases resolved
          WHERE resolved.tenant_id = stop.tenant_id
            AND resolved.stop_event_id = stop.event_id
       )
  );
END;

-- Historical acknowledgement/start facts remain in the event ledger after a stop. They still never
-- authorize moving the stopped projection back on their own; only a release of the holding stop does.
DROP TRIGGER work_packages_blocked_status_guard;

CREATE TRIGGER work_packages_blocked_status_guard
BEFORE UPDATE OF status ON work_packages
WHEN OLD.status = 'Blocked' AND NEW.status != 'Blocked'
BEGIN
  SELECT RAISE(ABORT, 'work_package_stop_release_required')
  WHERE NOT EXISTS (
    SELECT 1
      FROM work_package_stop_releases released
     WHERE released.tenant_id = OLD.tenant_id
       AND released.work_package_id = OLD.work_package_id
       AND released.work_package_version = OLD.version
  )
  OR EXISTS (
    SELECT 1
      FROM work_package_events stop
     WHERE stop.tenant_id = OLD.tenant_id
       AND stop.work_package_id = OLD.work_package_id
       AND stop.work_package_version = OLD.version
       AND stop.event_kind = 'stop_work'
       AND NOT EXISTS (
         SELECT 1
           FROM work_package_stop_releases resolved
          WHERE resolved.tenant_id = stop.tenant_id
            AND resolved.stop_event_id = stop.event_id
       )
  );
END;
