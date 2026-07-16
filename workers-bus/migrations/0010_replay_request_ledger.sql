-- 0010_replay_request_ledger.sql - race-safe run-id idempotency for admin replay.

CREATE TABLE IF NOT EXISTS replay_requests (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 3 AND 128),
  selection TEXT NOT NULL CHECK (selection IN ('targeted', 'bulk')),
  envelope_id TEXT,
  approved_by TEXT NOT NULL CHECK (length(approved_by) BETWEEN 3 AND 128),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  matched INTEGER,
  requeued INTEGER,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (selection = 'targeted' AND envelope_id IS NOT NULL)
    OR (selection = 'bulk' AND envelope_id IS NULL)
  ),
  CHECK (matched IS NULL OR matched >= 0),
  CHECK (requeued IS NULL OR (matched IS NOT NULL AND requeued BETWEEN 0 AND matched)),
  CHECK (
    status != 'completed'
    OR (matched IS NOT NULL AND requeued IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_replay_requests_status_updated
  ON replay_requests (status, updated_at);
