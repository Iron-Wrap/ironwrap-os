-- Structured linear observations stay on the existing field action/receipt authority.
-- Historical free-text notes stay in their immutable manifests; no guessed parsing or backfill.
ALTER TABLE field_actions ADD COLUMN measurement_area_label TEXT CHECK (
  measurement_area_label IS NULL OR (length(measurement_area_label) BETWEEN 1 AND 120 AND measurement_area_label = trim(measurement_area_label))
);
ALTER TABLE field_actions ADD COLUMN measurement_feet INTEGER CHECK (
  measurement_feet IS NULL OR (typeof(measurement_feet) = 'integer' AND measurement_feet BETWEEN 0 AND 100000)
);
ALTER TABLE field_actions ADD COLUMN measurement_inches INTEGER CHECK (
  measurement_inches IS NULL OR (typeof(measurement_inches) = 'integer' AND measurement_inches BETWEEN 0 AND 11)
);
ALTER TABLE field_actions ADD COLUMN measurement_eighths INTEGER CHECK (
  measurement_eighths IS NULL OR (typeof(measurement_eighths) = 'integer' AND measurement_eighths BETWEEN 0 AND 7)
);
ALTER TABLE field_actions ADD COLUMN measurement_total_eighth_inches INTEGER CHECK (
  measurement_total_eighth_inches IS NULL OR (typeof(measurement_total_eighth_inches) = 'integer' AND measurement_total_eighth_inches BETWEEN 1 AND 9600095)
);
ALTER TABLE field_actions ADD COLUMN measurement_device_id TEXT CHECK (
  measurement_device_id IS NULL OR (length(measurement_device_id) BETWEEN 12 AND 80 AND measurement_device_id NOT GLOB '*[^A-Za-z0-9._:-]*')
);
ALTER TABLE field_actions ADD COLUMN measurement_correction_of TEXT CHECK (
  measurement_correction_of IS NULL OR (length(measurement_correction_of) = 36 AND measurement_correction_of GLOB 'fci_*' AND substr(measurement_correction_of,5) NOT GLOB '*[^0-9a-f]*')
);

CREATE UNIQUE INDEX idx_field_measurement_checkin ON field_actions(tenant_id, checkin_id) WHERE measurement_area_label IS NOT NULL;
CREATE UNIQUE INDEX idx_field_measurement_successor ON field_actions(tenant_id, measurement_correction_of) WHERE measurement_correction_of IS NOT NULL;

CREATE TRIGGER field_measurement_shape BEFORE INSERT ON field_actions
WHEN NEW.measurement_area_label IS NOT NULL OR NEW.measurement_feet IS NOT NULL
  OR NEW.measurement_inches IS NOT NULL OR NEW.measurement_eighths IS NOT NULL
  OR NEW.measurement_total_eighth_inches IS NOT NULL OR NEW.measurement_device_id IS NOT NULL
  OR NEW.measurement_correction_of IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'field_measurement_shape_invalid') WHERE
    NEW.measurement_area_label IS NULL OR NEW.measurement_feet IS NULL
    OR NEW.measurement_inches IS NULL OR NEW.measurement_eighths IS NULL
    OR NEW.measurement_total_eighth_inches IS NULL OR NEW.measurement_device_id IS NULL
    OR NEW.measurement_total_eighth_inches IS NOT (NEW.measurement_feet * 96 + NEW.measurement_inches * 8 + NEW.measurement_eighths)
    OR NEW.capture_started_at IS NULL OR NEW.capture_completed_at IS NULL;
  SELECT RAISE(ABORT, 'field_measurement_actor_device_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM app_users actor JOIN app_devices device ON device.user_id = actor.user_id
      AND device.tenant_id = actor.tenant_id
    WHERE actor.user_id = NEW.user_id AND actor.tenant_id = NEW.tenant_id AND actor.active = 1
      AND COALESCE(actor.access_role, actor.role) = 'field'
      AND device.device_id = NEW.measurement_device_id AND device.revoked_at IS NULL
  );
END;

CREATE TRIGGER field_measurement_correction_guard BEFORE INSERT ON field_actions
WHEN NEW.measurement_correction_of IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'field_measurement_correction_invalid') WHERE NEW.correction_reason IS NULL OR NOT EXISTS (
    SELECT 1 FROM field_actions predecessor
    WHERE predecessor.tenant_id = NEW.tenant_id AND predecessor.checkin_id = NEW.measurement_correction_of
      AND predecessor.measurement_area_label IS NOT NULL AND predecessor.status = 'verified'
      AND predecessor.manifest_key IS NOT NULL AND predecessor.user_id = NEW.user_id
      AND predecessor.job_id = NEW.job_id AND predecessor.assignment_id = NEW.assignment_id
      AND predecessor.work_object_type IS NEW.work_object_type AND predecessor.work_object_id IS NEW.work_object_id
      AND predecessor.physical_context_type IS NEW.physical_context_type AND predecessor.physical_context_id IS NEW.physical_context_id
      AND predecessor.work_package_id IS NEW.work_package_id AND predecessor.work_package_version IS NEW.work_package_version
      AND predecessor.work_package_release_attempt_id IS NEW.work_package_release_attempt_id
      AND predecessor.evidence_slot_id IS NEW.evidence_slot_id
  );
  SELECT RAISE(ABORT, 'field_measurement_correction_conflict') WHERE EXISTS (
    SELECT 1 FROM field_actions successor WHERE successor.tenant_id = NEW.tenant_id
      AND successor.measurement_correction_of = NEW.measurement_correction_of
  );
END;

CREATE TRIGGER field_measurement_no_replace BEFORE INSERT ON field_actions
WHEN EXISTS (SELECT 1 FROM field_actions old WHERE old.device_action_id = NEW.device_action_id
  AND (old.measurement_area_label IS NOT NULL OR NEW.measurement_area_label IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'field_measurement_immutable'); END;

CREATE TRIGGER field_measurement_guard BEFORE UPDATE ON field_actions
BEGIN
  SELECT RAISE(ABORT, 'field_measurement_immutable') WHERE
    NEW.measurement_area_label IS NOT OLD.measurement_area_label OR NEW.measurement_feet IS NOT OLD.measurement_feet
    OR NEW.measurement_inches IS NOT OLD.measurement_inches OR NEW.measurement_eighths IS NOT OLD.measurement_eighths
    OR NEW.measurement_total_eighth_inches IS NOT OLD.measurement_total_eighth_inches
    OR NEW.measurement_device_id IS NOT OLD.measurement_device_id OR NEW.measurement_correction_of IS NOT OLD.measurement_correction_of
    OR (OLD.measurement_area_label IS NOT NULL AND OLD.manifest_key IS NOT NULL AND NEW.manifest_key IS NOT OLD.manifest_key)
    OR (OLD.measurement_area_label IS NOT NULL AND OLD.status = 'verified' AND (
      NEW.status IS NOT OLD.status OR NEW.response_json IS NOT OLD.response_json OR NEW.verified_at IS NOT OLD.verified_at
    ));
END;

CREATE TRIGGER field_measurement_no_delete BEFORE DELETE ON field_actions
WHEN OLD.measurement_area_label IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'field_measurement_immutable'); END;
