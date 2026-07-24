-- 0025_newo_control_evidence.sql - expiry, approval, and one-time execution evidence.

ALTER TABLE newo_control_actions ADD COLUMN approval_reason TEXT;
ALTER TABLE newo_control_actions ADD COLUMN dry_run_expires_at TEXT;
ALTER TABLE newo_control_actions ADD COLUMN approval_expires_at TEXT;
ALTER TABLE newo_control_actions ADD COLUMN result_json TEXT;
ALTER TABLE newo_control_actions ADD COLUMN consumed_at TEXT;
