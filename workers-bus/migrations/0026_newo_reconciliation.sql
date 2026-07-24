-- 0026_newo_reconciliation.sql - missing-report and operational reconciliation evidence.

ALTER TABLE newo_sessions ADD COLUMN report_expected_at TEXT;
ALTER TABLE newo_sessions ADD COLUMN report_received_at TEXT;
ALTER TABLE newo_sessions ADD COLUMN report_event_id TEXT;
ALTER TABLE newo_sessions ADD COLUMN missing_report_detected_at TEXT;
ALTER TABLE newo_sessions ADD COLUMN sync_updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_newo_sessions_missing_report
  ON newo_sessions (report_expected_at, missing_report_detected_at)
  WHERE report_received_at IS NULL;

CREATE TABLE IF NOT EXISTS newo_reconciliation_runs (
  run_id                   TEXT PRIMARY KEY,
  run_type                 TEXT NOT NULL CHECK (run_type IN ('five_minute','daily')),
  status                   TEXT NOT NULL CHECK (status IN ('ok','degraded','failed')),
  ran_at                   TEXT NOT NULL,
  retryable_syncs_requeued INTEGER NOT NULL DEFAULT 0 CHECK (retryable_syncs_requeued >= 0),
  missing_reports          INTEGER NOT NULL DEFAULT 0 CHECK (missing_reports >= 0),
  failed_handoffs          INTEGER NOT NULL DEFAULT 0 CHECK (failed_handoffs >= 0),
  pending_bookings         INTEGER NOT NULL DEFAULT 0 CHECK (pending_bookings >= 0),
  unresolved_incidents     INTEGER CHECK (unresolved_incidents IS NULL OR unresolved_incidents >= 0),
  drift_reasons_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(drift_reasons_json)),
  usage_status             TEXT NOT NULL CHECK (
    usage_status IN ('not_checked','within_limit','threshold_exceeded','unavailable_from_documented_api')
  ),
  usage_minutes            REAL CHECK (usage_minutes IS NULL OR usage_minutes >= 0),
  usage_limit_minutes      REAL CHECK (usage_limit_minutes IS NULL OR usage_limit_minutes > 0),
  detail_json              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json))
);

CREATE INDEX IF NOT EXISTS idx_newo_reconciliation_runs_at
  ON newo_reconciliation_runs (run_type, ran_at DESC);
