-- 0092_frappe_free_field_evidence.sql - D1-owned field evidence scope and capture times.
--
-- These facts were previously carried only to the compatibility writer.  Keep
-- them beside the existing field action idempotency boundary so D1 can verify
-- and project typed evidence without an ERP call.

ALTER TABLE field_actions ADD COLUMN work_object_type TEXT;
ALTER TABLE field_actions ADD COLUMN work_object_id TEXT;
ALTER TABLE field_actions ADD COLUMN physical_context_type TEXT;
ALTER TABLE field_actions ADD COLUMN physical_context_id TEXT;
ALTER TABLE field_actions ADD COLUMN capture_started_at TEXT;
ALTER TABLE field_actions ADD COLUMN capture_completed_at TEXT;

DROP TRIGGER IF EXISTS field_actions_work_package_binding_guard;

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
     OR NEW.correction_reason IS NOT OLD.correction_reason
     OR NEW.work_object_type IS NOT OLD.work_object_type
     OR NEW.work_object_id IS NOT OLD.work_object_id
     OR NEW.physical_context_type IS NOT OLD.physical_context_type
     OR NEW.physical_context_id IS NOT OLD.physical_context_id
     OR NEW.capture_started_at IS NOT OLD.capture_started_at
     OR NEW.capture_completed_at IS NOT OLD.capture_completed_at;
END;
