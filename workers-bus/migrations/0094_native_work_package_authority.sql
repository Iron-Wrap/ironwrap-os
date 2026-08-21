-- 0094_native_work_package_authority.sql - D1-owned Work Package authority.
--
-- The package snapshot is a read-optimized projection of the immutable
-- definition.  Every lifecycle transition is an append-only event; the
-- trigger below is the only thing allowed to advance the snapshot.  Frappe
-- may mirror these facts, but it cannot be required for a field action to
-- become verified.

CREATE TABLE IF NOT EXISTS work_packages (
  work_package_id TEXT NOT NULL CHECK (
    length(work_package_id) BETWEEN 1 AND 140
    AND work_package_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  job_id TEXT NOT NULL CHECK (length(trim(job_id)) BETWEEN 1 AND 140),
  assignment_id TEXT NOT NULL CHECK (length(trim(assignment_id)) BETWEEN 1 AND 140),
  work_object_type TEXT NOT NULL CHECK (length(trim(work_object_type)) BETWEEN 1 AND 140),
  work_object_id TEXT NOT NULL CHECK (length(trim(work_object_id)) BETWEEN 1 AND 140),
  physical_context_type TEXT NOT NULL CHECK (length(trim(physical_context_type)) BETWEEN 1 AND 140),
  physical_context_id TEXT NOT NULL CHECK (length(trim(physical_context_id)) BETWEEN 1 AND 140),
  assignment_authority_user TEXT,
  assignment_authority_role TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('Released', 'Acknowledged', 'In Progress', 'Blocked', 'Completed', 'Expired', 'Superseded')
  ),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  objective TEXT NOT NULL CHECK (length(trim(objective)) BETWEEN 1 AND 4000),
  boundaries TEXT NOT NULL CHECK (length(trim(boundaries)) BETWEEN 1 AND 4000),
  prerequisites TEXT NOT NULL CHECK (length(trim(prerequisites)) BETWEEN 1 AND 4000),
  expected_result TEXT NOT NULL CHECK (length(trim(expected_result)) BETWEEN 1 AND 4000),
  stop_conditions TEXT NOT NULL CHECK (length(trim(stop_conditions)) BETWEEN 1 AND 4000),
  make_safe_procedure TEXT NOT NULL CHECK (length(trim(make_safe_procedure)) BETWEEN 1 AND 4000),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND length(definition_json) <= 200000),
  issued_at TEXT NOT NULL CHECK (length(issued_at) BETWEEN 20 AND 40),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 40),
  released_at TEXT NOT NULL CHECK (length(released_at) BETWEEN 20 AND 40),
  release_attempt_id TEXT NOT NULL CHECK (length(trim(release_attempt_id)) BETWEEN 1 AND 140),
  supersedes_id TEXT,
  correction_reason TEXT,
  acknowledged_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (work_package_id, tenant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_work_packages_tenant_job
  ON work_packages (tenant_id, job_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_packages_tenant_assignment
  ON work_packages (tenant_id, assignment_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_packages_one_current_assignment
  ON work_packages (tenant_id, job_id, assignment_id)
  WHERE status IN ('Released', 'Acknowledged', 'In Progress');

CREATE TABLE IF NOT EXISTS work_package_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 8 AND 140
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  work_package_id TEXT NOT NULL,
  work_package_version INTEGER NOT NULL CHECK (work_package_version BETWEEN 1 AND 1000000),
  job_id TEXT NOT NULL CHECK (length(trim(job_id)) BETWEEN 1 AND 140),
  assignment_id TEXT NOT NULL CHECK (length(trim(assignment_id)) BETWEEN 1 AND 140),
  work_object_type TEXT NOT NULL CHECK (length(trim(work_object_type)) BETWEEN 1 AND 140),
  work_object_id TEXT NOT NULL CHECK (length(trim(work_object_id)) BETWEEN 1 AND 140),
  physical_context_type TEXT NOT NULL CHECK (length(trim(physical_context_type)) BETWEEN 1 AND 140),
  physical_context_id TEXT NOT NULL CHECK (length(trim(physical_context_id)) BETWEEN 1 AND 140),
  release_attempt_id TEXT NOT NULL CHECK (length(trim(release_attempt_id)) BETWEEN 1 AND 140),
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('issued', 'hold_released', 'acknowledged', 'start_work', 'stop_work', 'complete_work', 'evidence_reviewed', 'reconciled')
  ),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) BETWEEN 1 AND 140),
  actor_role TEXT NOT NULL CHECK (length(trim(actor_role)) BETWEEN 1 AND 140),
  device_action_id TEXT,
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  manifest_key TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 50000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, device_action_id),
  FOREIGN KEY (work_package_id, tenant_id, work_package_version)
    REFERENCES work_packages(work_package_id, tenant_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_work_package_events_package_time
  ON work_package_events (tenant_id, work_package_id, work_package_version, occurred_at, event_id);

CREATE INDEX IF NOT EXISTS idx_work_package_events_recovery
  ON work_package_events (tenant_id, event_kind, device_action_id, occurred_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_package_events_ack_actor
  ON work_package_events (tenant_id, work_package_id, work_package_version, event_kind, actor_user_id)
  WHERE event_kind = 'acknowledged';

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_package_events_hold_sequence
  ON work_package_events (
    tenant_id, work_package_id, work_package_version,
    json_extract(payload_json, '$.hold_point_sequence')
  )
  WHERE event_kind = 'hold_released';

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_package_events_review_target
  ON work_package_events (
    tenant_id, work_package_id, work_package_version,
    json_extract(payload_json, '$.target_event_id')
  )
  WHERE event_kind = 'evidence_reviewed';

CREATE TRIGGER work_package_events_authority_guard
BEFORE INSERT ON work_package_events
BEGIN
  SELECT RAISE(ABORT, 'work_package_event_scope_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM work_packages p
     WHERE p.tenant_id = NEW.tenant_id
       AND p.work_package_id = NEW.work_package_id
       AND p.version = NEW.work_package_version
       AND p.job_id = NEW.job_id
       AND p.assignment_id = NEW.assignment_id
       AND p.work_object_type = NEW.work_object_type
       AND p.work_object_id = NEW.work_object_id
       AND p.physical_context_type = NEW.physical_context_type
       AND p.physical_context_id = NEW.physical_context_id
       AND p.release_attempt_id = NEW.release_attempt_id
  );
  SELECT RAISE(ABORT, 'work_package_event_transition_invalid')
  WHERE (
    NEW.event_kind = 'issued'
    AND EXISTS (
      SELECT 1 FROM work_package_events e
       WHERE e.tenant_id = NEW.tenant_id
         AND e.work_package_id = NEW.work_package_id
         AND e.work_package_version = NEW.work_package_version
         AND e.event_kind = 'issued'
    )
  ) OR (
    NEW.event_kind = 'hold_released'
    AND NOT EXISTS (
      SELECT 1 FROM work_packages p
       WHERE p.tenant_id = NEW.tenant_id
         AND p.work_package_id = NEW.work_package_id
         AND p.version = NEW.work_package_version
         AND p.status IN ('Released', 'Acknowledged', 'In Progress')
         AND EXISTS (
           SELECT 1 FROM json_each(p.definition_json, '$.hold_points') h
            WHERE json_extract(h.value, '$.sequence') = json_extract(NEW.payload_json, '$.hold_point_sequence')
              AND length(trim(COALESCE(json_extract(NEW.payload_json, '$.evidence_item'), ''))) BETWEEN 12 AND 80
         )
    )
  ) OR (
    NEW.event_kind = 'evidence_reviewed'
    AND (
      json_extract(NEW.payload_json, '$.disposition') NOT IN ('Accepted', 'Needs Correction')
      OR length(trim(COALESCE(json_extract(NEW.payload_json, '$.target_event_id'), ''))) < 8
      OR length(trim(COALESCE(json_extract(NEW.payload_json, '$.evidence_item'), ''))) < 12
      OR length(trim(COALESCE(json_extract(NEW.payload_json, '$.evidence_slot_id'), ''))) < 6
      OR (
        json_extract(NEW.payload_json, '$.disposition') = 'Needs Correction'
        AND length(trim(COALESCE(json_extract(NEW.payload_json, '$.correction_reason'), ''))) = 0
      )
    )
  ) OR (
    NEW.event_kind = 'acknowledged'
    AND NOT EXISTS (
      SELECT 1 FROM work_packages p
       WHERE p.tenant_id = NEW.tenant_id
         AND p.work_package_id = NEW.work_package_id
         AND p.version = NEW.work_package_version
         AND p.status IN ('Released', 'Acknowledged')
         AND EXISTS (
           SELECT 1 FROM json_each(p.definition_json, '$.assigned_workers') w
            WHERE lower(json_extract(w.value, '$.worker_user')) = lower(NEW.actor_user_id)
              AND json_extract(w.value, '$.required') IN (1, '1', true)
         )
    )
  ) OR (
    NEW.event_kind = 'start_work'
    AND NOT EXISTS (
      SELECT 1 FROM work_packages p
       WHERE p.tenant_id = NEW.tenant_id
         AND p.work_package_id = NEW.work_package_id
         AND p.version = NEW.work_package_version
         AND p.status = 'Acknowledged'
         AND NOT EXISTS (
           SELECT 1
             FROM json_each(p.definition_json, '$.hold_points') h
            WHERE json_extract(h.value, '$.release_phase') = 'Pre-start'
              AND NOT EXISTS (
                SELECT 1 FROM work_package_events r
                 WHERE r.tenant_id = p.tenant_id
                   AND r.work_package_id = p.work_package_id
                   AND r.work_package_version = p.version
                   AND r.event_kind = 'hold_released'
                   AND json_extract(r.payload_json, '$.hold_point_sequence') = json_extract(h.value, '$.sequence')
              )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM json_each(p.definition_json, '$.assigned_workers') w
            WHERE json_extract(w.value, '$.required') IN (1, '1', true)
              AND NOT EXISTS (
                SELECT 1 FROM work_package_events a
                 WHERE a.tenant_id = p.tenant_id
                   AND a.work_package_id = p.work_package_id
                   AND a.work_package_version = p.version
                   AND a.event_kind = 'acknowledged'
                   AND lower(a.actor_user_id) = lower(json_extract(w.value, '$.worker_user'))
              )
         )
    )
  ) OR (
    NEW.event_kind = 'stop_work'
    AND NOT EXISTS (
      SELECT 1 FROM work_packages p
       WHERE p.tenant_id = NEW.tenant_id
         AND p.work_package_id = NEW.work_package_id
         AND p.version = NEW.work_package_version
         AND p.status IN ('Released', 'Acknowledged', 'In Progress')
    )
  ) OR (
    NEW.event_kind = 'complete_work'
    AND NOT EXISTS (
      SELECT 1 FROM work_packages p
       WHERE p.tenant_id = NEW.tenant_id
         AND p.work_package_id = NEW.work_package_id
         AND p.version = NEW.work_package_version
         AND p.status = 'In Progress'
    )
  );
END;

CREATE TRIGGER work_package_events_apply_transition
AFTER INSERT ON work_package_events
BEGIN
  UPDATE work_packages
     SET status = CASE NEW.event_kind
       WHEN 'acknowledged' THEN CASE WHEN status = 'Released' THEN 'Acknowledged' ELSE status END
       WHEN 'start_work' THEN 'In Progress'
       WHEN 'stop_work' THEN 'Blocked'
       WHEN 'complete_work' THEN 'Completed'
       ELSE status
     END,
         acknowledged_at = CASE WHEN NEW.event_kind = 'acknowledged' THEN COALESCE(acknowledged_at, NEW.occurred_at) ELSE acknowledged_at END,
         completed_at = CASE WHEN NEW.event_kind = 'complete_work' THEN NEW.occurred_at ELSE completed_at END,
         updated_at = NEW.occurred_at
   WHERE tenant_id = NEW.tenant_id
     AND work_package_id = NEW.work_package_id
     AND version = NEW.work_package_version;
END;

CREATE TRIGGER work_package_events_append_only_update
BEFORE UPDATE ON work_package_events
BEGIN
  SELECT RAISE(ABORT, 'work_package_event_append_only');
END;

CREATE TRIGGER work_package_events_append_only_delete
BEFORE DELETE ON work_package_events
BEGIN
  SELECT RAISE(ABORT, 'work_package_event_append_only');
END;

-- Extend the existing receipt ledger with the native event binding. Historical
-- receipts stay readable; new native commands fill every added field before
-- they can be returned as verified.
ALTER TABLE field_work_package_actions ADD COLUMN work_package_version INTEGER;
ALTER TABLE field_work_package_actions ADD COLUMN release_attempt_id TEXT;
ALTER TABLE field_work_package_actions ADD COLUMN work_object_type TEXT;
ALTER TABLE field_work_package_actions ADD COLUMN work_object_id TEXT;
ALTER TABLE field_work_package_actions ADD COLUMN physical_context_type TEXT;
ALTER TABLE field_work_package_actions ADD COLUMN physical_context_id TEXT;
ALTER TABLE field_work_package_actions ADD COLUMN event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_field_work_package_actions_event
  ON field_work_package_actions (tenant_id, event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_field_work_package_actions_package
  ON field_work_package_actions (
    tenant_id, work_package_id, work_package_version, action_kind, created_at DESC
  );

CREATE TRIGGER field_work_package_actions_native_binding_guard
BEFORE UPDATE ON field_work_package_actions
BEGIN
  SELECT RAISE(ABORT, 'work_package_action_binding_immutable')
  WHERE NEW.device_action_id != OLD.device_action_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.user_id != OLD.user_id
     OR NEW.job_id != OLD.job_id
     OR NEW.assignment_id != OLD.assignment_id
     OR NEW.work_package_id != OLD.work_package_id
     OR NEW.action_kind != OLD.action_kind
     OR NEW.payload_hash != OLD.payload_hash
     OR (
       NEW.event_id IS NULL
       AND (
         NEW.work_package_version IS NOT OLD.work_package_version
         OR NEW.release_attempt_id IS NOT OLD.release_attempt_id
         OR NEW.work_object_type IS NOT OLD.work_object_type
         OR NEW.work_object_id IS NOT OLD.work_object_id
         OR NEW.physical_context_type IS NOT OLD.physical_context_type
         OR NEW.physical_context_id IS NOT OLD.physical_context_id
       )
     )
     OR (
       NEW.event_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM work_package_events e
          WHERE e.event_id = NEW.event_id
            AND e.tenant_id = NEW.tenant_id
            AND e.device_action_id = NEW.device_action_id
            AND e.work_package_id = NEW.work_package_id
            AND e.work_package_version = NEW.work_package_version
            AND e.job_id = NEW.job_id
            AND e.assignment_id = NEW.assignment_id
            AND e.event_kind = CASE NEW.action_kind
              WHEN 'acknowledge' THEN 'acknowledged'
              ELSE NEW.action_kind
            END
       )
     )
     OR (
       OLD.event_id IS NOT NULL
       AND (
         NEW.event_id IS NOT OLD.event_id
         OR NEW.work_package_version IS NOT OLD.work_package_version
         OR NEW.release_attempt_id IS NOT OLD.release_attempt_id
         OR NEW.work_object_type IS NOT OLD.work_object_type
         OR NEW.work_object_id IS NOT OLD.work_object_id
         OR NEW.physical_context_type IS NOT OLD.physical_context_type
         OR NEW.physical_context_id IS NOT OLD.physical_context_id
       )
     );
END;
