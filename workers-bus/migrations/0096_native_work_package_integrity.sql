-- 0096_native_work_package_integrity.sql - close native Work Package write gaps.
--
-- Work-package definitions stay immutable. Lifecycle projection changes are
-- accepted only when backed by the append-only event ledger, while a package
-- replacement is backed by its own append-only supersession fact.

CREATE TABLE IF NOT EXISTS work_package_supersessions (
  supersession_id TEXT PRIMARY KEY CHECK (
    length(supersession_id) BETWEEN 8 AND 140
    AND supersession_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  device_action_id TEXT NOT NULL CHECK (length(trim(device_action_id)) BETWEEN 8 AND 80),
  command_sha256 TEXT NOT NULL CHECK (
    length(command_sha256) = 64
    AND command_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  prior_work_package_id TEXT NOT NULL,
  prior_work_package_version INTEGER NOT NULL CHECK (prior_work_package_version BETWEEN 1 AND 999999),
  replacement_work_package_id TEXT NOT NULL,
  replacement_work_package_version INTEGER NOT NULL CHECK (replacement_work_package_version BETWEEN 2 AND 1000000),
  job_id TEXT NOT NULL CHECK (length(trim(job_id)) BETWEEN 1 AND 140),
  assignment_id TEXT NOT NULL CHECK (length(trim(assignment_id)) BETWEEN 1 AND 140),
  work_object_type TEXT NOT NULL CHECK (length(trim(work_object_type)) BETWEEN 1 AND 140),
  work_object_id TEXT NOT NULL CHECK (length(trim(work_object_id)) BETWEEN 1 AND 140),
  physical_context_type TEXT NOT NULL CHECK (length(trim(physical_context_type)) BETWEEN 1 AND 140),
  physical_context_id TEXT NOT NULL CHECK (length(trim(physical_context_id)) BETWEEN 1 AND 140),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) BETWEEN 1 AND 140),
  actor_role TEXT NOT NULL CHECK (
    actor_role IN ('IronWrap Owner', 'System Manager', 'IronWrap Production')
  ),
  correction_reason TEXT NOT NULL CHECK (length(trim(correction_reason)) BETWEEN 1 AND 4000),
  manifest_key TEXT NOT NULL CHECK (length(trim(manifest_key)) BETWEEN 1 AND 1024),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (created_at = occurred_at),
  UNIQUE (tenant_id, device_action_id),
  UNIQUE (tenant_id, prior_work_package_id, prior_work_package_version),
  UNIQUE (tenant_id, replacement_work_package_id, replacement_work_package_version),
  FOREIGN KEY (prior_work_package_id, tenant_id, prior_work_package_version)
    REFERENCES work_packages(work_package_id, tenant_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (replacement_work_package_id, tenant_id, replacement_work_package_version)
    REFERENCES work_packages(work_package_id, tenant_id, version) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_work_package_supersessions_tenant_job
  ON work_package_supersessions (tenant_id, job_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_package_supersessions_replacement
  ON work_package_supersessions (
    tenant_id, replacement_work_package_id, replacement_work_package_version
  );

CREATE TRIGGER work_package_supersessions_validate_insert
BEFORE INSERT ON work_package_supersessions
BEGIN
  SELECT RAISE(ABORT, 'work_package_supersession_actor_invalid')
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
       )
  );
  SELECT RAISE(ABORT, 'work_package_supersession_scope_invalid')
  WHERE NEW.replacement_work_package_version != NEW.prior_work_package_version + 1
     OR NOT EXISTS (
       SELECT 1
         FROM work_packages prior
        WHERE prior.tenant_id = NEW.tenant_id
          AND prior.work_package_id = NEW.prior_work_package_id
          AND prior.version = NEW.prior_work_package_version
          AND prior.job_id = NEW.job_id
          AND prior.assignment_id = NEW.assignment_id
          AND prior.work_object_type = NEW.work_object_type
          AND prior.work_object_id = NEW.work_object_id
          AND prior.physical_context_type = NEW.physical_context_type
          AND prior.physical_context_id = NEW.physical_context_id
          AND prior.status IN ('Released', 'Acknowledged', 'In Progress', 'Blocked')
     );
END;

CREATE TRIGGER work_package_supersessions_apply
AFTER INSERT ON work_package_supersessions
BEGIN
  UPDATE work_packages
     SET status = 'Superseded', updated_at = NEW.occurred_at
   WHERE tenant_id = NEW.tenant_id
     AND work_package_id = NEW.prior_work_package_id
     AND version = NEW.prior_work_package_version;
END;

CREATE TRIGGER work_package_supersessions_append_only_update
BEFORE UPDATE ON work_package_supersessions
BEGIN
  SELECT RAISE(ABORT, 'work_package_supersessions_append_only');
END;

CREATE TRIGGER work_package_supersessions_append_only_delete
BEFORE DELETE ON work_package_supersessions
BEGIN
  SELECT RAISE(ABORT, 'work_package_supersessions_append_only');
END;

CREATE TRIGGER work_packages_validate_insert
BEFORE INSERT ON work_packages
BEGIN
  SELECT RAISE(ABORT, 'work_package_definition_binding_invalid')
  WHERE NEW.status != 'Released'
     OR NEW.created_at != NEW.issued_at
     OR NEW.updated_at != NEW.issued_at
     OR json_extract(NEW.definition_json, '$.tenant_id') IS NOT NEW.tenant_id
     OR json_extract(NEW.definition_json, '$.work_package_id') IS NOT NEW.work_package_id
     OR json_extract(NEW.definition_json, '$.version') IS NOT NEW.version
     OR json_extract(NEW.definition_json, '$.job_id') IS NOT NEW.job_id
     OR json_extract(NEW.definition_json, '$.assignment_id') IS NOT NEW.assignment_id
     OR json_extract(NEW.definition_json, '$.work_object_type') IS NOT NEW.work_object_type
     OR json_extract(NEW.definition_json, '$.work_object_id') IS NOT NEW.work_object_id
     OR json_extract(NEW.definition_json, '$.physical_context_type') IS NOT NEW.physical_context_type
     OR json_extract(NEW.definition_json, '$.physical_context_id') IS NOT NEW.physical_context_id
     OR json_extract(NEW.definition_json, '$.assignment_authority_user') IS NOT NEW.assignment_authority_user
     OR json_extract(NEW.definition_json, '$.assignment_authority_role') IS NOT NEW.assignment_authority_role
     OR json_extract(NEW.definition_json, '$.title') IS NOT NEW.title
     OR json_extract(NEW.definition_json, '$.objective') IS NOT NEW.objective
     OR json_extract(NEW.definition_json, '$.boundaries') IS NOT NEW.boundaries
     OR json_extract(NEW.definition_json, '$.prerequisites') IS NOT NEW.prerequisites
     OR json_extract(NEW.definition_json, '$.expected_result') IS NOT NEW.expected_result
     OR json_extract(NEW.definition_json, '$.stop_conditions') IS NOT NEW.stop_conditions
     OR json_extract(NEW.definition_json, '$.make_safe_procedure') IS NOT NEW.make_safe_procedure
     OR json_extract(NEW.definition_json, '$.issued_at') IS NOT NEW.issued_at
     OR json_extract(NEW.definition_json, '$.expires_at') IS NOT NEW.expires_at
     OR json_extract(NEW.definition_json, '$.released_at') IS NOT NEW.released_at
     OR json_extract(NEW.definition_json, '$.release_attempt_id') IS NOT NEW.release_attempt_id
     OR json_extract(NEW.definition_json, '$.supersedes_id') IS NOT NEW.supersedes_id
     OR json_extract(NEW.definition_json, '$.correction_reason') IS NOT NEW.correction_reason;
  SELECT RAISE(ABORT, 'work_package_supersession_required')
  WHERE (
    NEW.version = 1
    AND (NEW.supersedes_id IS NOT NULL OR NEW.correction_reason IS NOT NULL)
  ) OR (
    NEW.version > 1
    AND (
      NEW.supersedes_id IS NULL
      OR NEW.correction_reason IS NULL
      OR NOT EXISTS (
        SELECT 1
          FROM work_package_supersessions replacement
         WHERE replacement.tenant_id = NEW.tenant_id
           AND replacement.replacement_work_package_id = NEW.work_package_id
           AND replacement.replacement_work_package_version = NEW.version
           AND replacement.prior_work_package_id = NEW.supersedes_id
           AND replacement.prior_work_package_version = json_extract(NEW.definition_json, '$.supersedes_version')
           AND replacement.job_id = NEW.job_id
           AND replacement.assignment_id = NEW.assignment_id
           AND replacement.work_object_type = NEW.work_object_type
           AND replacement.work_object_id = NEW.work_object_id
           AND replacement.physical_context_type = NEW.physical_context_type
           AND replacement.physical_context_id = NEW.physical_context_id
           AND replacement.actor_user_id = json_extract(NEW.definition_json, '$.issued_by_user')
           AND replacement.actor_role = json_extract(NEW.definition_json, '$.issued_by_role')
           AND replacement.correction_reason = NEW.correction_reason
      )
    )
  );
END;

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

CREATE TRIGGER work_packages_no_delete
BEFORE DELETE ON work_packages
BEGIN
  SELECT RAISE(ABORT, 'work_packages_retained');
END;

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
         OR (actor.access_role = 'field' AND NEW.actor_role = 'Field Worker')
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
