-- 0005_quickbooks_webhook_receipts.sql - replay guard for signed QuickBooks webhooks.

CREATE TABLE IF NOT EXISTS quickbooks_webhook_receipts (
  payload_hash TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  events_count INTEGER NOT NULL DEFAULT 0,
  replay_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_qb_webhook_receipts_envelope
  ON quickbooks_webhook_receipts (envelope_id);
