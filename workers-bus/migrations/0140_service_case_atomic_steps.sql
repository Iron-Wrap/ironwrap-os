-- 0140: a D1 batch rolls back when a statement fails, but a versioned UPDATE that matches zero rows
-- succeeds. The service store inserts into this guard only when changes() says a child write or
-- case transition did not apply. The trigger aborts the whole batch, including preceding writes.
-- No successful operation leaves a row in this table.
CREATE TABLE IF NOT EXISTS service_case_batch_guard (
  kind TEXT NOT NULL PRIMARY KEY CHECK (kind IN ('child', 'transition'))
);

CREATE TRIGGER IF NOT EXISTS service_case_batch_guard_abort
BEFORE INSERT ON service_case_batch_guard
BEGIN
  SELECT RAISE(ABORT, 'service_case_child_write_conflict')
    WHERE NEW.kind = 'child';
  SELECT RAISE(ABORT, 'service_case_transition_conflict')
    WHERE NEW.kind = 'transition';
END;
