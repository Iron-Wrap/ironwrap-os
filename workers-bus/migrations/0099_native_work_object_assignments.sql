-- 0099_native_work_object_assignments.sql - append-only authority for typed physical work.
--
-- A typed assignment exists before its Work Package. The package may freeze
-- this record, but cannot create or infer assignment authority for itself.

CREATE TABLE IF NOT EXISTS operating_work_object_assignments (
  assignment_id TEXT PRIMARY KEY CHECK (
    length(assignment_id) BETWEEN 12 AND 200
    AND assignment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  work_object_type TEXT NOT NULL CHECK (
    length(trim(work_object_type)) BETWEEN 1 AND 140
    AND work_object_type != 'Roof Job'
  ),
  work_object_id TEXT NOT NULL CHECK (length(trim(work_object_id)) BETWEEN 1 AND 140),
  physical_context_type TEXT NOT NULL CHECK (
    length(trim(physical_context_type)) BETWEEN 1 AND 140
  ),
  physical_context_id TEXT NOT NULL CHECK (
    length(trim(physical_context_id)) BETWEEN 1 AND 140
  ),
  assignment_version INTEGER NOT NULL CHECK (assignment_version BETWEEN 1 AND 1000000),
  assigned_users_json TEXT NOT NULL CHECK (
    length(assigned_users_json) BETWEEN 3 AND 16384
    AND json_valid(assigned_users_json)
    AND json_type(assigned_users_json) = 'array'
    AND json_array_length(assigned_users_json) BETWEEN 1 AND 50
  ),
  scheduled_start TEXT NOT NULL CHECK (length(scheduled_start) BETWEEN 20 AND 40),
  scheduled_end TEXT CHECK (
    scheduled_end IS NULL
    OR (length(scheduled_end) BETWEEN 20 AND 40 AND scheduled_end > scheduled_start)
  ),
  authority_user_id TEXT NOT NULL,
  authority_role TEXT NOT NULL CHECK (authority_role IN ('owner', 'production')),
  supersedes_assignment_id TEXT,
  correction_reason TEXT CHECK (
    correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 3 AND 1200
  ),
  actor_user_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (assignment_id, tenant_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  UNIQUE (
    tenant_id, work_object_type, work_object_id,
    physical_context_type, physical_context_id, assignment_version
  ),
  FOREIGN KEY (authority_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_assignment_id, tenant_id)
    REFERENCES operating_work_object_assignments(assignment_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (assignment_version = 1 AND supersedes_assignment_id IS NULL AND correction_reason IS NULL)
    OR (assignment_version > 1 AND supersedes_assignment_id IS NOT NULL AND correction_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operating_work_object_assignments_predecessor
  ON operating_work_object_assignments (tenant_id, supersedes_assignment_id)
  WHERE supersedes_assignment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operating_work_object_assignments_scope
  ON operating_work_object_assignments (
    tenant_id, work_object_type, work_object_id,
    physical_context_type, physical_context_id, scheduled_start
  );

CREATE TRIGGER IF NOT EXISTS operating_work_object_assignments_validate_insert
BEFORE INSERT ON operating_work_object_assignments
BEGIN
  SELECT RAISE(ABORT, 'operating_work_object_assignment_actor_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.actor_user_id
       AND actor.active = 1
       AND actor.access_role IN ('owner', 'ops', 'production')
  );

  SELECT RAISE(ABORT, 'operating_work_object_assignment_authority_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users authority
     WHERE authority.tenant_id = NEW.tenant_id
       AND authority.user_id = NEW.authority_user_id
       AND authority.active = 1
       AND authority.access_role = NEW.authority_role
  );

  SELECT RAISE(ABORT, 'operating_work_object_assignment_roster_invalid')
  WHERE EXISTS (
    SELECT 1
      FROM json_each(NEW.assigned_users_json) member
      LEFT JOIN app_users worker
        ON worker.tenant_id = NEW.tenant_id
       AND worker.user_id = member.value
     WHERE member.type != 'text'
        OR length(trim(member.value)) NOT BETWEEN 8 AND 200
        OR worker.user_id IS NULL
        OR worker.active != 1
        OR worker.access_role != 'field'
  )
     OR EXISTS (
       SELECT 1
         FROM json_each(NEW.assigned_users_json) member
        GROUP BY lower(trim(member.value))
       HAVING COUNT(*) > 1
     );

  SELECT RAISE(ABORT, 'operating_work_object_assignment_chain_conflict')
  WHERE (
    NEW.supersedes_assignment_id IS NULL
    AND EXISTS (
      SELECT 1
        FROM operating_work_object_assignments current
       WHERE current.tenant_id = NEW.tenant_id
         AND current.work_object_type = NEW.work_object_type
         AND current.work_object_id = NEW.work_object_id
         AND current.physical_context_type = NEW.physical_context_type
         AND current.physical_context_id = NEW.physical_context_id
         AND NOT EXISTS (
           SELECT 1
             FROM operating_work_object_assignments successor
            WHERE successor.tenant_id = current.tenant_id
              AND successor.supersedes_assignment_id = current.assignment_id
         )
    )
  ) OR (
    NEW.supersedes_assignment_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM operating_work_object_assignments current
       WHERE current.tenant_id = NEW.tenant_id
         AND current.assignment_id = NEW.supersedes_assignment_id
         AND current.work_object_type = NEW.work_object_type
         AND current.work_object_id = NEW.work_object_id
         AND current.physical_context_type = NEW.physical_context_type
         AND current.physical_context_id = NEW.physical_context_id
         AND current.assignment_version + 1 = NEW.assignment_version
         AND NOT EXISTS (
           SELECT 1
             FROM operating_work_object_assignments successor
            WHERE successor.tenant_id = current.tenant_id
              AND successor.supersedes_assignment_id = current.assignment_id
         )
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS operating_work_object_assignments_append_only_update
BEFORE UPDATE ON operating_work_object_assignments
BEGIN SELECT RAISE(ABORT, 'operating_work_object_assignments_append_only'); END;

CREATE TRIGGER IF NOT EXISTS operating_work_object_assignments_append_only_delete
BEFORE DELETE ON operating_work_object_assignments
BEGIN SELECT RAISE(ABORT, 'operating_work_object_assignments_append_only'); END;
