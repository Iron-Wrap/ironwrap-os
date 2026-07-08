-- 0006_dedup_claims.sql - atomic phone/email dedup claims for generic lead ingest.

CREATE TABLE IF NOT EXISTS dedup_claims (
  dedup_key TEXT PRIMARY KEY,
  first_envelope_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dedup_claims_first_seen
  ON dedup_claims (first_seen_at);
