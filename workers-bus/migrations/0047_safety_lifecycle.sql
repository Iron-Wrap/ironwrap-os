-- 0047_safety_lifecycle.sql - owned safety equipment, occurrence, notification,
-- corrective-action, and readiness spine.
--
-- `Automation Incident` is an integration-failure record. A worker injury, near
-- miss, hazard, environmental event, or emergency is a different aggregate with a
-- different actor model and different rights, so it gets its own tables here
-- rather than overloading that one.
--
-- Three invariants are enforced by the schema, not by callers:
--
--   1. Reporting and making safe are intrinsic worker rights. Any active tenant
--      user may open an occurrence or record a make-safe/stop event. Inspection,
--      rescue command, regulatory notification, independent verification, and
--      release require the exact current authority.
--   2. Safety evidence is additive. Every `*_events` table refuses UPDATE and
--      DELETE, and every head row keeps identity columns immutable. Disabling
--      automation never deletes a safety record.
--   3. Whoever reported an occurrence, owns a corrective action, or captured its
--      evidence can never be the independent verifier of its closure.
--
-- Raw media stays in the approved evidence store; these rows retain references
-- and SHA-256 hashes only.

CREATE TABLE IF NOT EXISTS safety_equipment (
  equipment_id TEXT PRIMARY KEY CHECK (
    length(equipment_id) BETWEEN 3 AND 140
    AND equipment_id GLOB '[A-Za-z0-9]*'
    AND equipment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  equipment_kind TEXT NOT NULL CHECK (
    equipment_kind IN (
      'fall_arrest_harness', 'lanyard', 'anchor', 'ladder', 'respirator',
      'hearing_protection', 'eye_protection', 'hand_protection', 'head_protection',
      'gas_detector', 'fire_extinguisher', 'first_aid_kit', 'rescue_kit'
    )
  ),
  serial_number TEXT NOT NULL CHECK (length(trim(serial_number)) BETWEEN 1 AND 140),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  status TEXT NOT NULL DEFAULT 'in_service' CHECK (
    status IN ('in_service', 'quarantined', 'defective', 'replaced', 'retired')
  ),
  -- A worker holds an individually issued item. NULL means unassigned stock.
  assigned_user_id TEXT,
  assigned_at TEXT CHECK (assigned_at IS NULL OR length(assigned_at) BETWEEN 20 AND 40),
  -- The inspection interval is a control, not a suggestion: a missing or expired
  -- inspection blocks affected scope exactly like a failed one.
  inspection_interval_days INTEGER NOT NULL CHECK (inspection_interval_days BETWEEN 1 AND 3650),
  last_inspection_at TEXT CHECK (last_inspection_at IS NULL OR length(last_inspection_at) BETWEEN 20 AND 40),
  last_inspection_result TEXT CHECK (
    last_inspection_result IS NULL OR last_inspection_result IN ('pass', 'fail')
  ),
  inspection_due_at TEXT CHECK (inspection_due_at IS NULL OR length(inspection_due_at) BETWEEN 20 AND 40),
  replaced_by_equipment_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (equipment_id, tenant_id),
  UNIQUE (tenant_id, equipment_kind, serial_number),
  CHECK (
    (assigned_user_id IS NULL AND assigned_at IS NULL)
    OR (assigned_user_id IS NOT NULL AND assigned_at IS NOT NULL)
  ),
  CHECK (
    (last_inspection_at IS NULL AND last_inspection_result IS NULL AND inspection_due_at IS NULL)
    OR (last_inspection_at IS NOT NULL AND last_inspection_result IS NOT NULL AND inspection_due_at IS NOT NULL)
  ),
  CHECK (status != 'replaced' OR replaced_by_equipment_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_safety_equipment_tenant_status
  ON safety_equipment (tenant_id, status, inspection_due_at);

CREATE INDEX IF NOT EXISTS idx_safety_equipment_assignment
  ON safety_equipment (tenant_id, assigned_user_id, status)
  WHERE assigned_user_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS safety_equipment_validate_insert
BEFORE INSERT ON safety_equipment
BEGIN
  SELECT RAISE(ABORT, 'safety_equipment_assignee_unknown')
  WHERE NEW.assigned_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM app_users AS assignee
      WHERE assignee.user_id = NEW.assigned_user_id
        AND assignee.tenant_id = NEW.tenant_id
        AND assignee.active = 1
    );
END;

CREATE TRIGGER IF NOT EXISTS safety_equipment_identity_immutable
BEFORE UPDATE ON safety_equipment
BEGIN
  SELECT RAISE(ABORT, 'safety_equipment_identity_immutable')
  WHERE NEW.equipment_id != OLD.equipment_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.equipment_kind != OLD.equipment_kind
     OR NEW.serial_number != OLD.serial_number
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'safety_equipment_version_must_advance')
  WHERE NEW.version != OLD.version + 1;

  -- Retirement and replacement are terminal. A quarantined or defective item
  -- returns to service only through a passing inspection, never by edit.
  SELECT RAISE(ABORT, 'safety_equipment_state_invalid')
  WHERE OLD.status IN ('retired', 'replaced')
     OR (NEW.status = 'in_service' AND OLD.status != 'in_service'
         AND (NEW.last_inspection_result IS NOT 'pass'
              OR NEW.last_inspection_at IS OLD.last_inspection_at));

  SELECT RAISE(ABORT, 'safety_equipment_assignee_unknown')
  WHERE NEW.assigned_user_id IS NOT NULL
    AND NEW.assigned_user_id IS NOT OLD.assigned_user_id
    AND NOT EXISTS (
      SELECT 1 FROM app_users AS assignee
      WHERE assignee.user_id = NEW.assigned_user_id
        AND assignee.tenant_id = NEW.tenant_id
        AND assignee.active = 1
    );
END;

CREATE TRIGGER IF NOT EXISTS safety_equipment_append_only_delete
BEFORE DELETE ON safety_equipment
BEGIN
  SELECT RAISE(ABORT, 'safety_equipment_retained');
END;

CREATE TABLE IF NOT EXISTS safety_equipment_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 12 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  equipment_id TEXT NOT NULL,
  equipment_version INTEGER NOT NULL CHECK (equipment_version BETWEEN 1 AND 1000000),
  event_kind TEXT NOT NULL CHECK (
    event_kind IN (
      'issue', 'return', 'inspection_pass', 'inspection_fail',
      'defect_reported', 'quarantine', 'replacement', 'retire'
    )
  ),
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (length(actor_role) BETWEEN 3 AND 32),
  detail TEXT NOT NULL CHECK (length(trim(detail)) BETWEEN 3 AND 2000),
  evidence_refs_json TEXT CHECK (evidence_refs_json IS NULL OR length(trim(evidence_refs_json)) BETWEEN 2 AND 20000),
  evidence_sha256 TEXT CHECK (
    evidence_sha256 IS NULL
    OR (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40),
  device_action_id TEXT,
  UNIQUE (event_id, tenant_id),
  UNIQUE (tenant_id, equipment_id, equipment_version, event_kind),
  FOREIGN KEY (equipment_id, tenant_id)
    REFERENCES safety_equipment(equipment_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (evidence_refs_json IS NULL AND evidence_sha256 IS NULL)
    OR (evidence_refs_json IS NOT NULL AND evidence_sha256 IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_safety_equipment_events_item
  ON safety_equipment_events (tenant_id, equipment_id, equipment_version DESC, recorded_at DESC);

-- Inspecting equipment, quarantining it, and retiring it are competency-bound
-- acts. Reporting a defect is not: a worker who finds a cracked harness must be
-- able to say so from their own account.
CREATE TRIGGER IF NOT EXISTS safety_equipment_events_validate_actor
BEFORE INSERT ON safety_equipment_events
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS actor
    WHERE actor.user_id = NEW.actor_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND COALESCE(actor.access_role, actor.role) = NEW.actor_role
  );

  SELECT RAISE(ABORT, 'safety_inspection_authority_required')
  WHERE NEW.event_kind IN ('inspection_pass', 'inspection_fail', 'quarantine', 'retire', 'issue', 'replacement')
    AND NEW.actor_role NOT IN ('owner', 'ops', 'production', 'shop');
END;

CREATE TRIGGER IF NOT EXISTS safety_equipment_events_append_only_update
BEFORE UPDATE ON safety_equipment_events
BEGIN
  SELECT RAISE(ABORT, 'safety_equipment_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS safety_equipment_events_append_only_delete
BEFORE DELETE ON safety_equipment_events
BEGIN
  SELECT RAISE(ABORT, 'safety_equipment_events_retained');
END;

CREATE TABLE IF NOT EXISTS safety_occurrences (
  occurrence_id TEXT PRIMARY KEY CHECK (
    length(occurrence_id) BETWEEN 3 AND 140
    AND occurrence_id GLOB '[A-Za-z0-9]*'
    AND occurrence_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  occurrence_kind TEXT NOT NULL CHECK (
    occurrence_kind IN ('injury', 'near_miss', 'hazard', 'environmental', 'emergency')
  ),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'moderate', 'high', 'critical')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  state TEXT NOT NULL DEFAULT 'reported' CHECK (
    state IN ('reported', 'made_safe', 'investigating', 'controlled', 'closed')
  ),
  -- An active stop blocks its scope regardless of state. Only an authorized
  -- release clears it, and clearing never removes the occurrence record.
  stop_active INTEGER NOT NULL DEFAULT 1 CHECK (stop_active IN (0, 1)),
  rescue_required INTEGER NOT NULL DEFAULT 0 CHECK (rescue_required IN (0, 1)),
  rescue_completed_at TEXT CHECK (rescue_completed_at IS NULL OR length(rescue_completed_at) BETWEEN 20 AND 40),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('tenant', 'roof_job', 'work_package', 'shop', 'vehicle')
  ),
  scope_id TEXT NOT NULL CHECK (
    length(scope_id) BETWEEN 1 AND 140
    AND scope_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  reported_by_user_id TEXT NOT NULL,
  reported_at TEXT NOT NULL CHECK (length(reported_at) BETWEEN 20 AND 40),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 3 AND 4000),
  -- Deduplicates a duplicate offline report of the same physical event.
  report_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(report_fingerprint_sha256) = 64
    AND report_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  closed_at TEXT CHECK (closed_at IS NULL OR length(closed_at) BETWEEN 20 AND 40),
  UNIQUE (occurrence_id, tenant_id),
  UNIQUE (tenant_id, report_fingerprint_sha256),
  FOREIGN KEY (reported_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK (state != 'closed' OR (closed_at IS NOT NULL AND stop_active = 0)),
  CHECK (rescue_required = 1 OR rescue_completed_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_safety_occurrences_scope_open
  ON safety_occurrences (tenant_id, scope_type, scope_id, state, stop_active);

CREATE INDEX IF NOT EXISTS idx_safety_occurrences_tenant_reported
  ON safety_occurrences (tenant_id, reported_at DESC);

-- Reporting is a right, not a permission: any active tenant user qualifies.
CREATE TRIGGER IF NOT EXISTS safety_occurrences_validate_insert
BEFORE INSERT ON safety_occurrences
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS reporter
    WHERE reporter.user_id = NEW.reported_by_user_id
      AND reporter.tenant_id = NEW.tenant_id
      AND reporter.active = 1
  );
END;

CREATE TRIGGER IF NOT EXISTS safety_occurrences_identity_immutable
BEFORE UPDATE ON safety_occurrences
BEGIN
  SELECT RAISE(ABORT, 'safety_occurrence_identity_immutable')
  WHERE NEW.occurrence_id != OLD.occurrence_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.occurrence_kind != OLD.occurrence_kind
     OR NEW.scope_type != OLD.scope_type
     OR NEW.scope_id != OLD.scope_id
     OR NEW.reported_by_user_id != OLD.reported_by_user_id
     OR NEW.reported_at != OLD.reported_at
     OR NEW.summary != OLD.summary
     OR NEW.report_fingerprint_sha256 != OLD.report_fingerprint_sha256
     OR NEW.created_at != OLD.created_at;

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

CREATE TRIGGER IF NOT EXISTS safety_occurrences_append_only_delete
BEFORE DELETE ON safety_occurrences
BEGIN
  SELECT RAISE(ABORT, 'safety_occurrences_retained');
END;

CREATE TABLE IF NOT EXISTS safety_occurrence_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 12 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  occurrence_id TEXT NOT NULL,
  occurrence_version INTEGER NOT NULL CHECK (occurrence_version BETWEEN 1 AND 1000000),
  event_kind TEXT NOT NULL CHECK (
    event_kind IN (
      'reported', 'make_safe', 'rescue_dispatched', 'rescue_completed',
      'investigation_opened', 'finding_recorded', 'controlled', 'released', 'closed'
    )
  ),
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (length(actor_role) BETWEEN 3 AND 32),
  detail TEXT NOT NULL CHECK (length(trim(detail)) BETWEEN 3 AND 4000),
  evidence_refs_json TEXT CHECK (evidence_refs_json IS NULL OR length(trim(evidence_refs_json)) BETWEEN 2 AND 20000),
  evidence_sha256 TEXT CHECK (
    evidence_sha256 IS NULL
    OR (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  captured_offline INTEGER NOT NULL DEFAULT 0 CHECK (captured_offline IN (0, 1)),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40),
  device_action_id TEXT,
  UNIQUE (event_id, tenant_id),
  UNIQUE (tenant_id, occurrence_id, occurrence_version, event_kind),
  FOREIGN KEY (occurrence_id, tenant_id)
    REFERENCES safety_occurrences(occurrence_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (evidence_refs_json IS NULL AND evidence_sha256 IS NULL)
    OR (evidence_refs_json IS NOT NULL AND evidence_sha256 IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_safety_occurrence_events_occurrence
  ON safety_occurrence_events (tenant_id, occurrence_id, occurrence_version DESC, recorded_at DESC);

CREATE TRIGGER IF NOT EXISTS safety_occurrence_events_validate_actor
BEFORE INSERT ON safety_occurrence_events
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS actor
    WHERE actor.user_id = NEW.actor_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND COALESCE(actor.access_role, actor.role) = NEW.actor_role
  );

  -- Commanding a rescue and releasing a stop are authority acts.
  SELECT RAISE(ABORT, 'safety_rescue_authority_required')
  WHERE NEW.event_kind IN ('rescue_dispatched', 'rescue_completed')
    AND NEW.actor_role NOT IN ('owner', 'ops', 'production');

  SELECT RAISE(ABORT, 'safety_release_authority_required')
  WHERE NEW.event_kind IN ('controlled', 'released', 'closed')
    AND NEW.actor_role NOT IN ('owner', 'ops', 'production');
END;

CREATE TRIGGER IF NOT EXISTS safety_occurrence_events_append_only_update
BEFORE UPDATE ON safety_occurrence_events
BEGIN
  SELECT RAISE(ABORT, 'safety_occurrence_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS safety_occurrence_events_append_only_delete
BEFORE DELETE ON safety_occurrence_events
BEGIN
  SELECT RAISE(ABORT, 'safety_occurrence_events_retained');
END;

CREATE TABLE IF NOT EXISTS safety_notifications (
  notification_id TEXT PRIMARY KEY CHECK (
    length(notification_id) BETWEEN 3 AND 140
    AND notification_id GLOB '[A-Za-z0-9]*'
    AND notification_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  occurrence_id TEXT NOT NULL,
  authority_name TEXT NOT NULL CHECK (length(trim(authority_name)) BETWEEN 2 AND 200),
  authority_jurisdiction TEXT NOT NULL CHECK (length(trim(authority_jurisdiction)) BETWEEN 2 AND 160),
  notification_kind TEXT NOT NULL CHECK (
    notification_kind IN ('regulatory', 'insurer', 'client', 'manufacturer', 'emergency_services')
  ),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'submitted', 'acknowledged', 'not_required')
  ),
  due_at TEXT CHECK (due_at IS NULL OR length(due_at) BETWEEN 20 AND 40),
  submitted_at TEXT CHECK (submitted_at IS NULL OR length(submitted_at) BETWEEN 20 AND 40),
  submitted_by_user_id TEXT,
  external_reference TEXT CHECK (external_reference IS NULL OR length(trim(external_reference)) BETWEEN 1 AND 240),
  acknowledged_at TEXT CHECK (acknowledged_at IS NULL OR length(acknowledged_at) BETWEEN 20 AND 40),
  evidence_refs_json TEXT CHECK (evidence_refs_json IS NULL OR length(trim(evidence_refs_json)) BETWEEN 2 AND 20000),
  evidence_sha256 TEXT CHECK (
    evidence_sha256 IS NULL
    OR (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  determination_reason TEXT NOT NULL CHECK (length(trim(determination_reason)) BETWEEN 3 AND 2000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (notification_id, tenant_id),
  UNIQUE (tenant_id, occurrence_id, authority_name, notification_kind),
  FOREIGN KEY (occurrence_id, tenant_id)
    REFERENCES safety_occurrences(occurrence_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (submitted_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'submitted' OR state = 'acknowledged')
      = (submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL AND external_reference IS NOT NULL)
  ),
  CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL)),
  CHECK (required = 1 OR state = 'not_required')
);

CREATE INDEX IF NOT EXISTS idx_safety_notifications_open
  ON safety_notifications (tenant_id, occurrence_id, state, due_at);

CREATE TRIGGER IF NOT EXISTS safety_notifications_validate_insert
BEFORE INSERT ON safety_notifications
BEGIN
  SELECT RAISE(ABORT, 'safety_notification_authority_required')
  WHERE NEW.submitted_by_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM app_users AS actor
      WHERE actor.user_id = NEW.submitted_by_user_id
        AND actor.tenant_id = NEW.tenant_id
        AND actor.active = 1
        AND COALESCE(actor.access_role, actor.role) IN ('owner', 'ops')
    );
END;

CREATE TRIGGER IF NOT EXISTS safety_notifications_guard_update
BEFORE UPDATE ON safety_notifications
BEGIN
  SELECT RAISE(ABORT, 'safety_notification_identity_immutable')
  WHERE NEW.notification_id != OLD.notification_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.occurrence_id != OLD.occurrence_id
     OR NEW.authority_name != OLD.authority_name
     OR NEW.authority_jurisdiction != OLD.authority_jurisdiction
     OR NEW.notification_kind != OLD.notification_kind
     OR NEW.required != OLD.required
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'safety_notification_state_invalid')
  WHERE OLD.state IN ('acknowledged', 'not_required')
     OR (OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'submitted'))
     OR (OLD.state = 'submitted' AND NEW.state NOT IN ('submitted', 'acknowledged'));

  SELECT RAISE(ABORT, 'safety_notification_authority_required')
  WHERE NEW.submitted_by_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM app_users AS actor
      WHERE actor.user_id = NEW.submitted_by_user_id
        AND actor.tenant_id = NEW.tenant_id
        AND actor.active = 1
        AND COALESCE(actor.access_role, actor.role) IN ('owner', 'ops')
    );
END;

CREATE TRIGGER IF NOT EXISTS safety_notifications_append_only_delete
BEFORE DELETE ON safety_notifications
BEGIN
  SELECT RAISE(ABORT, 'safety_notifications_retained');
END;

CREATE TABLE IF NOT EXISTS safety_corrective_actions (
  corrective_action_id TEXT PRIMARY KEY CHECK (
    length(corrective_action_id) BETWEEN 3 AND 140
    AND corrective_action_id GLOB '[A-Za-z0-9]*'
    AND corrective_action_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  occurrence_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  state TEXT NOT NULL DEFAULT 'open' CHECK (
    state IN ('open', 'evidence_submitted', 'verified', 'closed', 'rejected')
  ),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'moderate', 'high', 'critical')),
  owner_user_id TEXT NOT NULL,
  assigned_by_user_id TEXT NOT NULL,
  due_at TEXT NOT NULL CHECK (length(due_at) BETWEEN 20 AND 40),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 4000),
  -- A repeat of a previously closed action is a systemic signal, so the link is
  -- part of the record rather than a comment.
  recurrence_of_id TEXT,
  evidence_refs_json TEXT CHECK (evidence_refs_json IS NULL OR length(trim(evidence_refs_json)) BETWEEN 2 AND 20000),
  evidence_sha256 TEXT CHECK (
    evidence_sha256 IS NULL
    OR (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  evidence_captured_by_user_id TEXT,
  evidence_submitted_at TEXT CHECK (evidence_submitted_at IS NULL OR length(evidence_submitted_at) BETWEEN 20 AND 40),
  verified_by_user_id TEXT,
  verified_at TEXT CHECK (verified_at IS NULL OR length(verified_at) BETWEEN 20 AND 40),
  closed_at TEXT CHECK (closed_at IS NULL OR length(closed_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (corrective_action_id, tenant_id),
  FOREIGN KEY (occurrence_id, tenant_id)
    REFERENCES safety_occurrences(occurrence_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (verified_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_captured_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (recurrence_of_id, tenant_id)
    REFERENCES safety_corrective_actions(corrective_action_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('evidence_submitted', 'verified', 'closed'))
      = (evidence_refs_json IS NOT NULL AND evidence_sha256 IS NOT NULL
         AND evidence_captured_by_user_id IS NOT NULL AND evidence_submitted_at IS NOT NULL)
  ),
  CHECK ((state IN ('verified', 'closed')) = (verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK (recurrence_of_id IS NULL OR recurrence_of_id != corrective_action_id)
);

CREATE INDEX IF NOT EXISTS idx_safety_corrective_actions_open
  ON safety_corrective_actions (tenant_id, state, risk_level, due_at);

CREATE INDEX IF NOT EXISTS idx_safety_corrective_actions_occurrence
  ON safety_corrective_actions (tenant_id, occurrence_id, state);

CREATE TRIGGER IF NOT EXISTS safety_corrective_actions_validate_insert
BEFORE INSERT ON safety_corrective_actions
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS owner_user
    WHERE owner_user.user_id = NEW.owner_user_id
      AND owner_user.tenant_id = NEW.tenant_id
      AND owner_user.active = 1
  );

  SELECT RAISE(ABORT, 'safety_assignment_authority_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS assigner
    WHERE assigner.user_id = NEW.assigned_by_user_id
      AND assigner.tenant_id = NEW.tenant_id
      AND assigner.active = 1
      AND COALESCE(assigner.access_role, assigner.role) IN ('owner', 'ops', 'production')
  );
END;

-- Separation of duties. The person who reported the occurrence, the person who
-- owns the fix, and the person who captured its evidence cannot be the one who
-- independently verifies that the fix worked.
CREATE TRIGGER IF NOT EXISTS safety_corrective_actions_guard_update
BEFORE UPDATE ON safety_corrective_actions
BEGIN
  SELECT RAISE(ABORT, 'safety_corrective_action_identity_immutable')
  WHERE NEW.corrective_action_id != OLD.corrective_action_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.occurrence_id != OLD.occurrence_id
     OR NEW.owner_user_id != OLD.owner_user_id
     OR NEW.assigned_by_user_id != OLD.assigned_by_user_id
     OR NEW.description != OLD.description
     OR NEW.recurrence_of_id IS NOT OLD.recurrence_of_id
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'safety_corrective_action_version_must_advance')
  WHERE NEW.version != OLD.version + 1;

  SELECT RAISE(ABORT, 'safety_corrective_action_state_invalid')
  WHERE OLD.state IN ('closed', 'rejected')
     OR (OLD.state = 'open' AND NEW.state NOT IN ('open', 'evidence_submitted'))
     OR (OLD.state = 'evidence_submitted' AND NEW.state NOT IN ('evidence_submitted', 'verified', 'rejected'))
     OR (OLD.state = 'verified' AND NEW.state NOT IN ('verified', 'closed'));

  SELECT RAISE(ABORT, 'safety_verification_authority_required')
  WHERE NEW.verified_by_user_id IS NOT NULL
    AND NEW.verified_by_user_id IS NOT OLD.verified_by_user_id
    AND NOT EXISTS (
      SELECT 1 FROM app_users AS verifier
      WHERE verifier.user_id = NEW.verified_by_user_id
        AND verifier.tenant_id = NEW.tenant_id
        AND verifier.active = 1
        AND COALESCE(verifier.access_role, verifier.role) IN ('owner', 'ops', 'production')
    );

  SELECT RAISE(ABORT, 'safety_verification_separation_required')
  WHERE NEW.verified_by_user_id IS NOT NULL
    AND (
      NEW.verified_by_user_id = NEW.owner_user_id
      OR NEW.verified_by_user_id IS NEW.evidence_captured_by_user_id
      OR NEW.verified_by_user_id = (
        SELECT occurrence.reported_by_user_id
        FROM safety_occurrences AS occurrence
        WHERE occurrence.occurrence_id = NEW.occurrence_id
          AND occurrence.tenant_id = NEW.tenant_id
      )
    );
END;

CREATE TRIGGER IF NOT EXISTS safety_corrective_actions_append_only_delete
BEFORE DELETE ON safety_corrective_actions
BEGIN
  SELECT RAISE(ABORT, 'safety_corrective_actions_retained');
END;

CREATE TABLE IF NOT EXISTS safety_corrective_action_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 12 AND 160
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  corrective_action_id TEXT NOT NULL,
  corrective_action_version INTEGER NOT NULL CHECK (corrective_action_version BETWEEN 1 AND 1000000),
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('assigned', 'evidence_submitted', 'verified', 'rejected', 'closed', 'overdue_flagged')
  ),
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (length(actor_role) BETWEEN 3 AND 32),
  detail TEXT NOT NULL CHECK (length(trim(detail)) BETWEEN 3 AND 4000),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40),
  UNIQUE (event_id, tenant_id),
  UNIQUE (tenant_id, corrective_action_id, corrective_action_version, event_kind),
  FOREIGN KEY (corrective_action_id, tenant_id)
    REFERENCES safety_corrective_actions(corrective_action_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_safety_corrective_action_events_action
  ON safety_corrective_action_events (tenant_id, corrective_action_id, corrective_action_version DESC, recorded_at DESC);

CREATE TRIGGER IF NOT EXISTS safety_corrective_action_events_validate_actor
BEFORE INSERT ON safety_corrective_action_events
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS actor
    WHERE actor.user_id = NEW.actor_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND COALESCE(actor.access_role, actor.role) = NEW.actor_role
  );

  SELECT RAISE(ABORT, 'safety_verification_authority_required')
  WHERE NEW.event_kind IN ('verified', 'rejected', 'closed')
    AND NEW.actor_role NOT IN ('owner', 'ops', 'production');
END;

CREATE TRIGGER IF NOT EXISTS safety_corrective_action_events_append_only_update
BEFORE UPDATE ON safety_corrective_action_events
BEGIN
  SELECT RAISE(ABORT, 'safety_corrective_action_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS safety_corrective_action_events_append_only_delete
BEFORE DELETE ON safety_corrective_action_events
BEGIN
  SELECT RAISE(ABORT, 'safety_corrective_action_events_retained');
END;

-- An immutable answer to "what did the release gate actually see?". Work
-- Package and schedule release both read current readiness and durably record
-- the exact blockers that were present at that instant.
CREATE TABLE IF NOT EXISTS safety_readiness_snapshots (
  snapshot_id TEXT PRIMARY KEY CHECK (
    length(snapshot_id) BETWEEN 12 AND 160
    AND snapshot_id GLOB '[A-Za-z0-9]*'
    AND snapshot_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('tenant', 'roof_job', 'work_package', 'shop', 'vehicle')
  ),
  scope_id TEXT NOT NULL CHECK (
    length(scope_id) BETWEEN 1 AND 140
    AND scope_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  consumer TEXT NOT NULL CHECK (
    consumer IN ('work_package_release', 'schedule_release', 'field_panel', 'audit')
  ),
  ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
  blocker_codes TEXT NOT NULL CHECK (length(trim(blocker_codes)) BETWEEN 0 AND 2000),
  blockers_json TEXT NOT NULL CHECK (length(trim(blockers_json)) BETWEEN 2 AND 20000),
  snapshot_sha256 TEXT NOT NULL CHECK (
    length(snapshot_sha256) = 64
    AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evaluated_by_user_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL CHECK (length(evaluated_at) BETWEEN 20 AND 40),
  UNIQUE (snapshot_id, tenant_id),
  FOREIGN KEY (evaluated_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK ((ready = 1) = (length(trim(blocker_codes)) = 0))
);

CREATE INDEX IF NOT EXISTS idx_safety_readiness_snapshots_scope
  ON safety_readiness_snapshots (tenant_id, scope_type, scope_id, evaluated_at DESC);

CREATE TRIGGER IF NOT EXISTS safety_readiness_snapshots_append_only_update
BEFORE UPDATE ON safety_readiness_snapshots
BEGIN
  SELECT RAISE(ABORT, 'safety_readiness_snapshots_append_only');
END;

CREATE TRIGGER IF NOT EXISTS safety_readiness_snapshots_append_only_delete
BEFORE DELETE ON safety_readiness_snapshots
BEGIN
  SELECT RAISE(ABORT, 'safety_readiness_snapshots_retained');
END;

-- The safety action ledger is deliberately separate from
-- field_work_package_actions. A worker must be able to report a hazard or make
-- an area safe with no current work package, no assignment, and no job, and a
-- lost response must replay to the same durable record rather than creating a
-- second incident.
CREATE TABLE IF NOT EXISTS safety_device_actions (
  device_action_id TEXT PRIMARY KEY CHECK (
    length(device_action_id) BETWEEN 8 AND 80
    AND device_action_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 140),
  action_kind TEXT NOT NULL CHECK (
    action_kind IN ('report_occurrence', 'make_safe', 'equipment_defect', 'rescue_request')
  ),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('tenant', 'roof_job', 'work_package', 'shop', 'vehicle')
  ),
  scope_id TEXT NOT NULL CHECK (
    length(scope_id) BETWEEN 1 AND 140
    AND scope_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('processing', 'r2_stored', 'verified', 'retryable_error')),
  manifest_key TEXT,
  processing_token TEXT,
  lease_expires_at TEXT,
  response_json TEXT,
  last_error TEXT,
  captured_at TEXT NOT NULL CHECK (length(captured_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  verified_at TEXT,
  CHECK (
    (status = 'verified' AND response_json IS NOT NULL AND verified_at IS NOT NULL)
    OR (status != 'verified' AND verified_at IS NULL)
  ),
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_safety_device_actions_recovery
  ON safety_device_actions (status, lease_expires_at, updated_at)
  WHERE status IN ('processing', 'r2_stored', 'retryable_error');

CREATE INDEX IF NOT EXISTS idx_safety_device_actions_user
  ON safety_device_actions (tenant_id, user_id, created_at DESC);

-- Reporting and make-safe accept any active tenant user. This trigger exists to
-- refuse an unknown or deactivated identity, never to gate the right itself.
CREATE TRIGGER IF NOT EXISTS safety_device_actions_validate_actor
BEFORE INSERT ON safety_device_actions
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS actor
    WHERE actor.user_id = NEW.user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
  );
END;

CREATE TRIGGER IF NOT EXISTS safety_device_actions_identity_immutable
BEFORE UPDATE ON safety_device_actions
BEGIN
  SELECT RAISE(ABORT, 'safety_device_action_identity_immutable')
  WHERE NEW.device_action_id != OLD.device_action_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.user_id != OLD.user_id
     OR NEW.action_kind != OLD.action_kind
     OR NEW.scope_type != OLD.scope_type
     OR NEW.scope_id != OLD.scope_id
     OR NEW.payload_hash != OLD.payload_hash
     OR NEW.captured_at != OLD.captured_at
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'safety_device_action_verified_immutable')
  WHERE OLD.status = 'verified' AND NEW.status != 'verified';
END;

CREATE TRIGGER IF NOT EXISTS safety_device_actions_append_only_delete
BEFORE DELETE ON safety_device_actions
BEGIN
  SELECT RAISE(ABORT, 'safety_device_actions_retained');
END;
