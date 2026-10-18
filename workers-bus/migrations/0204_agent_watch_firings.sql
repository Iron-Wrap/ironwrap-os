-- AI team watches (Track A, AI-TEAM-CONTRACT.md "Watches and reports").
--
-- A standing watch fires once per period of its cadence. Its deterministic condition runs first
-- and costs no model call; when it holds, the firing appends a watch signal for the owning
-- specialist, and when it does not, the firing is still recorded, as an empty run. One firing per
-- watch and period: the period key is the dedupe, so a retried or overlapping cron tick cannot fire
-- a watch twice.

CREATE TABLE IF NOT EXISTS agent_watch_firings (
  firing_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  watch_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  condition_version TEXT NOT NULL,
  holds INTEGER NOT NULL CHECK (holds IN (0, 1)),
  signal_id TEXT REFERENCES agent_signals (signal_id),
  summary TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  UNIQUE (tenant_id, watch_id, period_key),
  CHECK ((holds = 1) = (signal_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_watch_firings_recent
  ON agent_watch_firings (tenant_id, watch_id, fired_at);

CREATE TRIGGER IF NOT EXISTS prevent_agent_watch_firing_update
BEFORE UPDATE ON agent_watch_firings
BEGIN
  SELECT RAISE(ABORT, 'agent_watch_firings_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_watch_firing_delete
BEFORE DELETE ON agent_watch_firings
BEGIN
  SELECT RAISE(ABORT, 'agent_watch_firings_append_only');
END;

CREATE TRIGGER IF NOT EXISTS agent_watch_firings_guard
BEFORE INSERT ON agent_watch_firings
BEGIN
  SELECT RAISE(ABORT, 'agent_watch_firings_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_watch_firings f WHERE f.firing_id = NEW.firing_id
      OR (f.tenant_id = NEW.tenant_id AND f.watch_id = NEW.watch_id AND f.period_key = NEW.period_key)
  );
END;

-- Owner report deliveries outside the app: one row per attempt, so a failed delivery is visible and
-- retried (by the cron, and by the host's close replay), and a sent report is never sent twice.
CREATE TABLE IF NOT EXISTS agent_report_deliveries (
  delivery_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs (run_id),
  watch_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  detail TEXT,
  attempted_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_report_deliveries_sent
  ON agent_report_deliveries (tenant_id, run_id) WHERE outcome = 'sent';

CREATE TRIGGER IF NOT EXISTS prevent_agent_report_delivery_update
BEFORE UPDATE ON agent_report_deliveries
BEGIN
  SELECT RAISE(ABORT, 'agent_report_deliveries_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_report_delivery_delete
BEFORE DELETE ON agent_report_deliveries
BEGIN
  SELECT RAISE(ABORT, 'agent_report_deliveries_append_only');
END;

CREATE TRIGGER IF NOT EXISTS agent_report_deliveries_guard
BEFORE INSERT ON agent_report_deliveries
BEGIN
  SELECT RAISE(ABORT, 'agent_report_deliveries_append_only') WHERE EXISTS (
    SELECT 1 FROM agent_report_deliveries d WHERE d.delivery_id = NEW.delivery_id
      OR (NEW.outcome = 'sent' AND d.tenant_id = NEW.tenant_id AND d.run_id = NEW.run_id AND d.outcome = 'sent')
  );
END;

-- Reports find a watch's run by its signal.
CREATE INDEX IF NOT EXISTS idx_agent_runs_signal ON agent_runs (tenant_id, signal_id);
