-- 0044_work_package_evidence_slots.sql - typed, resumable Work Package evidence binding.
--
-- Work Package evidence is still carried by the existing field_checkin
-- idempotency boundary. These nullable columns make the package/version/slot
-- contract durable for both offline recovery and duplicate-safe replay without
-- storing raw media or mutable provider payloads in D1.

ALTER TABLE field_actions ADD COLUMN work_package_id TEXT;
ALTER TABLE field_actions ADD COLUMN work_package_version INTEGER;
ALTER TABLE field_actions ADD COLUMN evidence_slot_id TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_requirement TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_source TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_device_id TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_freshness TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_conflict_state TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_verification TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_disposition TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_correction_of TEXT;
ALTER TABLE field_actions ADD COLUMN evidence_item_correction_of TEXT;
ALTER TABLE field_actions ADD COLUMN work_package_release_attempt_id TEXT;
ALTER TABLE field_actions ADD COLUMN correction_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_field_actions_work_package_evidence
  ON field_actions (tenant_id, work_package_id, work_package_version, evidence_slot_id, created_at DESC)
  WHERE work_package_id IS NOT NULL;

CREATE TRIGGER field_actions_work_package_binding_shape
BEFORE INSERT ON field_actions
BEGIN
  SELECT RAISE(ABORT, 'field_action_work_package_binding_invalid')
  WHERE (
      NEW.work_package_id IS NOT NULL
      OR NEW.work_package_version IS NOT NULL
      OR NEW.evidence_slot_id IS NOT NULL
      OR NEW.evidence_requirement IS NOT NULL
      OR NEW.evidence_source IS NOT NULL
      OR NEW.evidence_device_id IS NOT NULL
      OR NEW.evidence_freshness IS NOT NULL
      OR NEW.evidence_conflict_state IS NOT NULL
      OR NEW.evidence_verification IS NOT NULL
      OR NEW.evidence_disposition IS NOT NULL
      OR NEW.evidence_correction_of IS NOT NULL
      OR NEW.evidence_item_correction_of IS NOT NULL
      OR NEW.work_package_release_attempt_id IS NOT NULL
    )
    AND (
      NEW.work_package_id IS NULL
      OR NEW.work_package_version IS NULL
      OR NEW.work_package_version < 1
      OR NEW.work_package_release_attempt_id IS NULL
      OR NEW.evidence_slot_id IS NULL
      OR NEW.evidence_requirement IS NULL
      OR NEW.evidence_source IS NULL
      OR NEW.evidence_device_id IS NULL
      OR NEW.evidence_freshness NOT IN ('Current', 'Stale', 'Unknown')
      OR NEW.evidence_conflict_state NOT IN ('None', 'Detected', 'Resolved')
      OR NEW.evidence_verification IS NOT 'Verified'
      OR NEW.evidence_disposition IS NOT 'Open'
      OR (NEW.evidence_correction_of IS NULL AND NEW.evidence_item_correction_of IS NOT NULL)
      OR (NEW.evidence_correction_of IS NOT NULL AND NEW.evidence_item_correction_of IS NULL)
      OR (NEW.work_package_id IS NOT NULL AND NEW.evidence_correction_of IS NULL
          AND NEW.evidence_item_correction_of IS NULL
          AND NEW.correction_reason IS NOT NULL)
      OR (NEW.work_package_id IS NOT NULL AND NEW.evidence_correction_of IS NOT NULL
          AND NEW.evidence_item_correction_of IS NULL)
      OR (NEW.work_package_id IS NOT NULL AND NEW.evidence_correction_of IS NULL
          AND NEW.evidence_item_correction_of IS NOT NULL)
      OR (NEW.work_package_id IS NOT NULL AND NEW.evidence_correction_of IS NOT NULL
          AND NEW.correction_reason IS NULL)
    );
END;

CREATE TRIGGER field_actions_work_package_binding_guard
BEFORE UPDATE ON field_actions
BEGIN
  SELECT RAISE(ABORT, 'field_action_work_package_binding_immutable')
  WHERE NEW.device_action_id != OLD.device_action_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.user_id != OLD.user_id
     OR NEW.job_id != OLD.job_id
     OR NEW.assignment_id != OLD.assignment_id
     OR NEW.action_kind != OLD.action_kind
     OR NEW.payload_hash != OLD.payload_hash
     OR NEW.checkin_id != OLD.checkin_id
     OR NEW.work_package_id IS NOT OLD.work_package_id
     OR NEW.work_package_version IS NOT OLD.work_package_version
     OR NEW.evidence_slot_id IS NOT OLD.evidence_slot_id
     OR NEW.evidence_requirement IS NOT OLD.evidence_requirement
     OR NEW.evidence_source IS NOT OLD.evidence_source
     OR NEW.evidence_device_id IS NOT OLD.evidence_device_id
     OR NEW.evidence_freshness IS NOT OLD.evidence_freshness
     OR NEW.evidence_conflict_state IS NOT OLD.evidence_conflict_state
     OR NEW.evidence_verification IS NOT OLD.evidence_verification
     OR NEW.evidence_disposition IS NOT OLD.evidence_disposition
     OR NEW.evidence_correction_of IS NOT OLD.evidence_correction_of
     OR NEW.evidence_item_correction_of IS NOT OLD.evidence_item_correction_of
     OR NEW.work_package_release_attempt_id IS NOT OLD.work_package_release_attempt_id
     OR NEW.correction_reason IS NOT OLD.correction_reason;
END;
