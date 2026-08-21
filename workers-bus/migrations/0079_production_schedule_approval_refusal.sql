-- 0079_production_schedule_approval_refusal.sql - keep the reason a production
-- schedule was refused, not just the fact that it was.
--
-- A refusal the domain authored ("this crew member's Worker Competency is not on
-- file for this job") used to be destroyed on the way out of Frappe and reached the
-- approving office user as an opaque `execution_uncertain` - "something went wrong",
-- about a decision the system made deliberately (ELEC-132 defect B). The approve
-- response carries the reason now, and so must the record: an approver who re-opens
-- the request tomorrow needs the same sentence the one who clicked approve saw.
--
-- Additive expand migration: one nullable column, no rewrite of shipped rows.
-- `error_code` still carries the machine code; this is the human half beside it.

ALTER TABLE production_schedule_approval_requests
  ADD COLUMN refusal_message TEXT;

-- SQLite cannot add a CHECK to an existing table, and this column must never become a
-- free-text field: it is bounded, single-line and only meaningful on `failed`, the one
-- terminal state that means "the domain decided against this", never on an execution
-- whose outcome is unknown.
CREATE TRIGGER IF NOT EXISTS enforce_production_schedule_approval_refusal_message
BEFORE UPDATE OF refusal_message ON production_schedule_approval_requests
WHEN NEW.refusal_message IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'production_schedule_approval_refusal_requires_failed_state')
    WHERE NEW.state != 'failed';
  SELECT RAISE(ABORT, 'production_schedule_approval_refusal_message_invalid')
    WHERE length(NEW.refusal_message) NOT BETWEEN 3 AND 400
      OR NEW.refusal_message GLOB '*[^A-Za-z0-9 ,.:;''()_@/+#-]*';
  SELECT RAISE(ABORT, 'production_schedule_approval_refusal_immutable')
    WHERE OLD.refusal_message IS NOT NULL AND OLD.refusal_message IS NOT NEW.refusal_message;
END;

CREATE TRIGGER IF NOT EXISTS prevent_production_schedule_approval_refusal_insert
BEFORE INSERT ON production_schedule_approval_requests
WHEN NEW.refusal_message IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'production_schedule_approval_refusal_requires_failed_state');
END;
