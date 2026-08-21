-- Preserve contextual assignment roles (Installer, Spotter, etc.) in immutable
-- Work Package events while app_users.access_role remains the field access gate.

DROP TRIGGER work_package_events_native_identity_guard;

CREATE TRIGGER work_package_events_native_identity_guard
BEFORE INSERT ON work_package_events
BEGIN
  SELECT RAISE(ABORT, 'work_package_event_evidence_required')
  WHERE NEW.device_action_id IS NULL
     OR length(trim(NEW.device_action_id)) NOT BETWEEN 8 AND 80
     OR NEW.manifest_key IS NULL
     OR length(trim(NEW.manifest_key)) NOT BETWEEN 1 AND 1024
     OR NEW.created_at != NEW.occurred_at;
  SELECT RAISE(ABORT, 'work_package_event_actor_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.actor_user_id
       AND actor.active = 1
       AND (
         (actor.access_role = 'owner' AND NEW.actor_role = 'IronWrap Owner')
         OR (actor.access_role = 'ops' AND NEW.actor_role = 'System Manager')
         OR (actor.access_role = 'production' AND NEW.actor_role = 'IronWrap Production')
         OR (
           actor.access_role = 'field'
           AND NEW.event_kind IN ('acknowledged', 'start_work', 'stop_work')
           AND EXISTS (
             SELECT 1
               FROM work_packages package,
                    json_each(package.definition_json, '$.assigned_workers') worker
              WHERE package.tenant_id = NEW.tenant_id
                AND package.work_package_id = NEW.work_package_id
                AND package.version = NEW.work_package_version
                AND json_extract(worker.value, '$.required') IN (1, '1', true)
                AND json_extract(worker.value, '$.worker_user') = NEW.actor_user_id
                AND json_extract(worker.value, '$.worker_role') = NEW.actor_role
           )
         )
       )
  );
  SELECT RAISE(ABORT, 'work_package_hold_release_authority_required')
  WHERE NEW.event_kind = 'hold_released'
    AND NOT EXISTS (
      SELECT 1
        FROM work_packages package,
             json_each(package.definition_json, '$.hold_points') hold
       WHERE package.tenant_id = NEW.tenant_id
         AND package.work_package_id = NEW.work_package_id
         AND package.version = NEW.work_package_version
         AND json_extract(hold.value, '$.sequence') = json_extract(NEW.payload_json, '$.hold_point_sequence')
         AND (
           (NEW.actor_role = 'IronWrap Owner'
             AND lower(trim(json_extract(hold.value, '$.release_authority'))) IN ('ironwrap owner', 'owner'))
           OR (NEW.actor_role = 'System Manager'
             AND lower(trim(json_extract(hold.value, '$.release_authority'))) IN ('system manager', 'operations', 'supervisor'))
           OR (NEW.actor_role = 'IronWrap Production'
             AND lower(trim(json_extract(hold.value, '$.release_authority'))) IN ('ironwrap production', 'production', 'supervisor'))
         )
         AND (
           package.work_object_type = 'Roof Job'
           OR (
             package.assignment_authority_user = NEW.actor_user_id
             AND (
               package.assignment_authority_role IS NULL
               OR package.assignment_authority_role = NEW.actor_role
             )
           )
         )
    );
  SELECT RAISE(ABORT, 'work_package_event_time_invalid')
  WHERE NEW.occurred_at < (
      SELECT issued_at
        FROM work_packages package
       WHERE package.tenant_id = NEW.tenant_id
         AND package.work_package_id = NEW.work_package_id
         AND package.version = NEW.work_package_version
    )
     OR NEW.occurred_at < COALESCE((
       SELECT MAX(existing.occurred_at)
         FROM work_package_events existing
        WHERE existing.tenant_id = NEW.tenant_id
          AND existing.work_package_id = NEW.work_package_id
          AND existing.work_package_version = NEW.work_package_version
     ), NEW.occurred_at);
  SELECT RAISE(ABORT, 'work_package_issued_event_invalid')
  WHERE NEW.event_kind = 'issued'
    AND NOT EXISTS (
      SELECT 1
        FROM work_packages package
       WHERE package.tenant_id = NEW.tenant_id
         AND package.work_package_id = NEW.work_package_id
         AND package.version = NEW.work_package_version
         AND NEW.actor_user_id = json_extract(package.definition_json, '$.issued_by_user')
         AND NEW.actor_role = json_extract(package.definition_json, '$.issued_by_role')
         AND length(json_extract(NEW.payload_json, '$.definition_sha256')) = 64
         AND json_extract(NEW.payload_json, '$.definition_sha256') NOT GLOB '*[^0-9a-f]*'
         AND json_extract(NEW.payload_json, '$.command_sha256') = json_extract(NEW.payload_json, '$.definition_sha256')
    );
  SELECT RAISE(ABORT, 'work_package_worker_event_invalid')
  WHERE NEW.event_kind IN ('acknowledged', 'start_work', 'stop_work')
    AND NOT EXISTS (
      SELECT 1
        FROM work_packages package, json_each(package.definition_json, '$.assigned_workers') worker
       WHERE package.tenant_id = NEW.tenant_id
         AND package.work_package_id = NEW.work_package_id
         AND package.version = NEW.work_package_version
         AND json_extract(worker.value, '$.required') IN (1, '1', true)
         AND json_extract(worker.value, '$.worker_user') = NEW.actor_user_id
         AND json_extract(worker.value, '$.worker_role') = NEW.actor_role
    );
  SELECT RAISE(ABORT, 'work_package_office_event_invalid')
  WHERE NEW.event_kind IN ('complete_work', 'evidence_reviewed')
    AND NOT EXISTS (
      SELECT 1
        FROM work_packages package
       WHERE package.tenant_id = NEW.tenant_id
         AND package.work_package_id = NEW.work_package_id
         AND package.version = NEW.work_package_version
         AND (
           (
             package.work_object_type = 'Roof Job'
             AND NEW.actor_role IN ('IronWrap Owner', 'System Manager', 'IronWrap Production')
           ) OR (
             package.work_object_type != 'Roof Job'
             AND package.assignment_authority_user = NEW.actor_user_id
             AND package.assignment_authority_role = NEW.actor_role
           )
         )
    );
END;
