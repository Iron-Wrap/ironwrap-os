-- 0031_quickbooks_projection_outbox.sql - durable per-entity Frappe projection state.
--
-- A signed webhook receipt proves only that the raw payload was accepted.  Each
-- supported entity is retained here until its idempotent Pending reconciliation
-- projection has reached Frappe.  A short lease prevents concurrent redelivery
-- from executing the same projection twice; an expired lease is retryable.

CREATE TABLE IF NOT EXISTS quickbooks_projection_outbox (
  payload_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL CHECK (event_index >= 0),
  realm_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  projection_status TEXT NOT NULL CHECK (projection_status IN ('pending', 'projected', 'rejected')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  last_attempt_at TEXT,
  next_attempt_at TEXT NOT NULL,
  escalated_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  projected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (payload_hash, event_index),
  FOREIGN KEY (payload_hash) REFERENCES quickbooks_webhook_receipts(payload_hash) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_qb_projection_outbox_pending
  ON quickbooks_projection_outbox (projection_status, next_attempt_at, lease_expires_at, updated_at);
