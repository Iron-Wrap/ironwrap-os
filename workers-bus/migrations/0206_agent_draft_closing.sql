-- AI team: closing a prepared people-only draft (Track A, AI-TEAM-CONTRACT.md "Action classes",
-- contract f5).
--
-- A decided step is final (0200). One exception: a draft that prepared a people-only act and still
-- waits in its person's Needs you closes, still `succeeded`, when the person makes the change
-- (`applied_by_person`) or something else replaces it (`superseded`). Only the closing fields move:
-- the reason code, the policy's reason codes, the ask, the readback naming the record, the do-it-
-- myself context that says what is set now, and the decision time and version. Its permit, tool,
-- undo, reviewer and policy result stay as they were. Every comparison is null-safe (IS), so a
-- column that is NULL can never switch the exception on.

DROP TRIGGER IF EXISTS prevent_decided_agent_step_update;

CREATE TRIGGER IF NOT EXISTS prevent_decided_agent_step_update
BEFORE UPDATE ON agent_run_steps
WHEN OLD.outcome IS NOT NULL AND OLD.outcome <> 'unknown'
  AND NOT (
    OLD.outcome IS 'succeeded'
    AND OLD.needs_ask IS 'apply_in_own_screen'
    AND NEW.outcome IS 'succeeded'
    AND NEW.needs_ask IS NULL
    AND COALESCE(NEW.reason_code IN ('applied_by_person', 'superseded'), 0)
    AND NEW.permit_json IS OLD.permit_json
    AND NEW.tool_json IS OLD.tool_json
    AND NEW.undo_json IS OLD.undo_json
    AND NEW.needs_reviewer_role IS OLD.needs_reviewer_role
    AND NEW.needs_person_id IS OLD.needs_person_id
    AND json_extract(NEW.policy_json, '$.result') IS json_extract(OLD.policy_json, '$.result')
    AND json_extract(NEW.policy_json, '$.reason_codes') IS json_array(NEW.reason_code)
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_step_decided');
END;
