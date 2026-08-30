-- 0130_work_package_assignment_snapshot_guard.sql
-- Bind every new Work Package to the exact still-current assignment snapshot.
-- Historical packages keep NULLs and remain readable/stop-only.

ALTER TABLE work_packages ADD COLUMN assignment_version INTEGER CHECK (
  assignment_version IS NULL OR assignment_version BETWEEN 1 AND 1000000
);
ALTER TABLE work_packages ADD COLUMN assignment_command_fingerprint TEXT CHECK (
  assignment_command_fingerprint IS NULL OR (
    length(assignment_command_fingerprint) = 64
    AND assignment_command_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE work_packages ADD COLUMN assignment_authority_requirements_sha256 TEXT CHECK (
  assignment_authority_requirements_sha256 IS NULL OR (
    length(assignment_authority_requirements_sha256) = 64
    AND assignment_authority_requirements_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER work_packages_assignment_snapshot_guard
BEFORE INSERT ON work_packages
WHEN NEW.assignment_version IS NOT NULL
  OR NEW.assignment_command_fingerprint IS NOT NULL
  OR NEW.assignment_authority_requirements_sha256 IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'work_package_assignment_snapshot_stale')
  WHERE NEW.assignment_command_fingerprint IS NULL
     OR NEW.assignment_authority_requirements_sha256 IS NULL
     OR json_extract(NEW.definition_json, '$.assignment_version') IS NOT NEW.assignment_version
     OR json_extract(NEW.definition_json, '$.assignment_command_fingerprint') IS NOT NEW.assignment_command_fingerprint
     OR json_extract(NEW.definition_json, '$.assignment_authority_requirements_sha256') IS NOT NEW.assignment_authority_requirements_sha256
     OR NOT (
       (
         NEW.work_object_type = 'Roof Job'
         AND EXISTS (
           SELECT 1
             FROM operating_job_assignments assignment
            WHERE assignment.tenant_id = NEW.tenant_id
              AND assignment.assignment_id = NEW.assignment_id
              AND assignment.roof_job_id = NEW.job_id
              AND assignment.roof_job_id = NEW.work_object_id
              AND assignment.assignment_version = NEW.assignment_version
              AND assignment.command_fingerprint = NEW.assignment_command_fingerprint
              AND assignment.authority_requirements_sha256 = NEW.assignment_authority_requirements_sha256
              AND NOT EXISTS (
                SELECT 1
                  FROM operating_job_assignments successor
                 WHERE successor.tenant_id = assignment.tenant_id
                   AND successor.supersedes_assignment_id = assignment.assignment_id
              )
         )
       )
       OR (
         NEW.work_object_type <> 'Roof Job'
         AND EXISTS (
           SELECT 1
             FROM operating_work_object_assignments assignment
            WHERE assignment.tenant_id = NEW.tenant_id
              AND assignment.assignment_id = NEW.assignment_id
              AND assignment.work_object_type = NEW.work_object_type
              AND assignment.work_object_id = NEW.work_object_id
              AND assignment.physical_context_type = NEW.physical_context_type
              AND assignment.physical_context_id = NEW.physical_context_id
              AND assignment.assignment_version = NEW.assignment_version
              AND assignment.command_fingerprint = NEW.assignment_command_fingerprint
              AND assignment.authority_requirements_sha256 = NEW.assignment_authority_requirements_sha256
              AND NOT EXISTS (
                SELECT 1
                  FROM operating_work_object_assignments successor
                 WHERE successor.tenant_id = assignment.tenant_id
                   AND successor.supersedes_assignment_id = assignment.assignment_id
              )
         )
       )
     );
END;

CREATE TRIGGER work_packages_assignment_snapshot_immutable
BEFORE UPDATE ON work_packages
BEGIN
  SELECT RAISE(ABORT, 'work_package_definition_immutable')
  WHERE NEW.assignment_version IS NOT OLD.assignment_version
     OR NEW.assignment_command_fingerprint IS NOT OLD.assignment_command_fingerprint
     OR NEW.assignment_authority_requirements_sha256 IS NOT OLD.assignment_authority_requirements_sha256;
END;
