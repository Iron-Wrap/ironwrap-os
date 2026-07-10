-- 0009_replay_approval_audit.sql - non-secret human approval evidence for mutations.

ALTER TABLE audit_log ADD COLUMN run_id TEXT;
ALTER TABLE audit_log ADD COLUMN approved_by TEXT;
ALTER TABLE audit_log ADD COLUMN reason TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_run_id ON audit_log (run_id, ts);
