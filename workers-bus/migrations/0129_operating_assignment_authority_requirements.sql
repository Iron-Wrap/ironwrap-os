-- 0129_operating_assignment_authority_requirements.sql
-- Freeze the governed authority policy on the immutable assignment command.
-- Historical assignments remain readable but authority-unknown; only a new
-- assignment with a complete validated snapshot may issue a Work Package.

ALTER TABLE operating_job_assignments
  ADD COLUMN authority_requirements_json TEXT CHECK (
    authority_requirements_json IS NULL OR (
      json_valid(authority_requirements_json)
      AND json_type(authority_requirements_json) = 'array'
      AND json_array_length(authority_requirements_json) BETWEEN 1 AND 20
      AND length(authority_requirements_json) <= 20000
    )
  );

ALTER TABLE operating_job_assignments
  ADD COLUMN authority_requirements_sha256 TEXT CHECK (
    authority_requirements_sha256 IS NULL OR (
      length(authority_requirements_sha256) = 64
      AND authority_requirements_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE operating_work_object_assignments
  ADD COLUMN authority_requirements_json TEXT CHECK (
    authority_requirements_json IS NULL OR (
      json_valid(authority_requirements_json)
      AND json_type(authority_requirements_json) = 'array'
      AND json_array_length(authority_requirements_json) BETWEEN 1 AND 20
      AND length(authority_requirements_json) <= 20000
    )
  );

ALTER TABLE operating_work_object_assignments
  ADD COLUMN authority_requirements_sha256 TEXT CHECK (
    authority_requirements_sha256 IS NULL OR (
      length(authority_requirements_sha256) = 64
      AND authority_requirements_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  );
