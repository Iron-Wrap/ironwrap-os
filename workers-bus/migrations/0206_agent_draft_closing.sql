-- AI team: closing a prepared people-only draft (Track A, AI-TEAM-CONTRACT.md "Action classes",
-- contract f5).
--
-- A decided step is final (0200). One exception: a draft that prepared a people-only act (a
-- delegation proposal or an access change; no other draft closes yet) and still waits in its
-- person's Needs you closes once, still `succeeded`, when a person acts on its record
-- by hand (`applied_by_person`) or a newer draft replaces it (`superseded`). The trigger body is
-- 0200's plus that one clause. Only the closing fields move: the reason code, the policy's reason
-- codes, the ask (to NULL, so a closed draft never closes again or reopens), the readback naming
-- the record, the do-it-myself context that says what is set now, the version (by exactly one) and
-- the decision time (D1's clock, not the caller's). Every other column stays as it was. Every
-- comparison is null-safe (IS), so a column that is NULL can never switch the exception on.

DROP TRIGGER IF EXISTS prevent_decided_agent_step_update;

CREATE TRIGGER IF NOT EXISTS prevent_decided_agent_step_update
BEFORE UPDATE ON agent_run_steps
WHEN OLD.outcome IS NOT NULL AND OLD.outcome <> 'unknown'
  AND NOT (
    OLD.outcome IS 'succeeded'
    AND OLD.action_id IN ('delegation.propose_change', 'access.prepare_change')
    AND OLD.needs_ask IS 'apply_in_own_screen'
    AND NEW.needs_ask IS NULL
    AND COALESCE(NEW.reason_code IN ('applied_by_person', 'superseded'), 0)
    AND json_extract(NEW.policy_json, '$.reason_codes') IS json_array(NEW.reason_code)
    AND json_remove(NEW.policy_json, '$.reason_codes') IS json_remove(OLD.policy_json, '$.reason_codes')
    AND json_remove(NEW.do_it_myself_json, '$.context.applied') IS json_remove(OLD.do_it_myself_json, '$.context.applied')
    AND NEW.version IS OLD.version + 1
    AND NEW.decided_at IS strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND NEW.outcome IS OLD.outcome
    AND NEW.step_id IS OLD.step_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.run_id IS OLD.run_id
    AND NEW.step_seq IS OLD.step_seq
    AND NEW.step_key IS OLD.step_key
    AND NEW.specialist_id IS OLD.specialist_id
    AND NEW.action_id IS OLD.action_id
    AND NEW.autonomy IS OLD.autonomy
    AND NEW.args_json IS OLD.args_json
    AND NEW.args_sha256 IS OLD.args_sha256
    AND NEW.sources_json IS OLD.sources_json
    AND NEW.permit_json IS OLD.permit_json
    AND NEW.tool_json IS OLD.tool_json
    AND NEW.needs_reviewer_role IS OLD.needs_reviewer_role
    AND NEW.needs_person_id IS OLD.needs_person_id
    AND NEW.undo_json IS OLD.undo_json
    AND NEW.created_at IS OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_step_decided');
END;
