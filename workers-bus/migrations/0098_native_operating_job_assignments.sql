-- 0098_native_operating_job_assignments.sql - append-only D1 scheduling authority.
--
-- A schedule revision freezes the exact job, crew, and active field roster it was
-- authorized against. Work Packages continue to own execution state.

CREATE TABLE IF NOT EXISTS operating_job_assignments (
  assignment_id TEXT PRIMARY KEY CHECK (
    length(assignment_id) BETWEEN 12 AND 200
    AND assignment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  roof_job_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL CHECK (assignment_version BETWEEN 1 AND 1000000),
  roof_job_version INTEGER NOT NULL CHECK (roof_job_version BETWEEN 1 AND 1000000),
  crew_id TEXT NOT NULL,
  crew_version INTEGER NOT NULL CHECK (crew_version BETWEEN 1 AND 1000000),
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
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (crew_id, tenant_id)
    REFERENCES fleet_crews(crew_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_assignment_id, tenant_id)
    REFERENCES operating_job_assignments(assignment_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (assignment_version = 1 AND supersedes_assignment_id IS NULL AND correction_reason IS NULL)
    OR (assignment_version > 1 AND supersedes_assignment_id IS NOT NULL AND correction_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operating_job_assignments_job_version
  ON operating_job_assignments (tenant_id, roof_job_id, assignment_version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operating_job_assignments_predecessor
  ON operating_job_assignments (tenant_id, supersedes_assignment_id)
  WHERE supersedes_assignment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operating_job_assignments_schedule
  ON operating_job_assignments (tenant_id, scheduled_start, roof_job_id);

CREATE TRIGGER IF NOT EXISTS operating_job_assignments_validate_insert
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

CREATE TRIGGER IF NOT EXISTS operating_job_assignments_append_only_update
BEFORE UPDATE ON operating_job_assignments
BEGIN SELECT RAISE(ABORT, 'operating_job_assignments_append_only'); END;

CREATE TRIGGER IF NOT EXISTS operating_job_assignments_append_only_delete
BEFORE DELETE ON operating_job_assignments
BEGIN SELECT RAISE(ABORT, 'operating_job_assignments_append_only'); END;
