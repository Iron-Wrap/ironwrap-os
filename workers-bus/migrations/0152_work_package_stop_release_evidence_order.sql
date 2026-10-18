-- 0152_work_package_stop_release_evidence_order.sql - correction evidence that releases a crew
-- stop was captured after that stop.
--
-- 0145 admits a release citing any verified, stored Work Package capture of the job, including one
-- taken before the stop it releases. A capture from before the stop shows the conditions the crew
-- stopped on, never that their cause was corrected, so it can never release the stop. Each cited
-- capture must now carry a capture time strictly after the stop event's own time. The capture time
-- is the one the field evidence record carries: the device's capture completion, or the server
-- receipt for a capture stored without one. Both times are compared as instants, so differences in
-- stored precision or offset cannot reorder them, and a time that does not parse never qualifies.
--
-- The 0145 insert guard is re-created under its name with every clause unchanged plus this one,
-- answered after the evidence clause so an invalid citation still reports itself first. Triggers on
-- one table fire newest first, so 0145's replace guard is then re-created unchanged: a replayed or
-- second release still reports itself before validation, exactly as under 0145. Object counts are
-- unchanged.

DROP TRIGGER work_package_stop_releases_validate_insert;

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

  -- Each cited capture was taken strictly after the stop it releases: the one capture the clause
  -- above admits for a reference also has a capture time later than the stop event.
  SELECT RAISE(ABORT, 'work_package_stop_release_evidence_before_stop')
  WHERE EXISTS (
    SELECT 1
      FROM json_each(NEW.evidence_refs_json) item
     WHERE (
       SELECT COUNT(*)
         FROM field_actions capture
         JOIN field_action_media media ON media.device_action_id = capture.device_action_id
         JOIN work_package_events stop
           ON stop.tenant_id = NEW.tenant_id
          AND stop.event_id = NEW.stop_event_id
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
          AND julianday(COALESCE(capture.capture_completed_at, capture.created_at))
            > julianday(stop.occurred_at)
     ) != 1
  );
END;

-- 0145's replace guard, unchanged, re-created after the insert guard so it still fires first.
DROP TRIGGER work_package_stop_releases_no_insert_replace;

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
