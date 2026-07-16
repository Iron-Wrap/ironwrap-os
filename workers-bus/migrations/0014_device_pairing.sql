-- 0014_device_pairing.sql - office-issued, revocable Field Companion device pairing.
-- Pairing and device secrets are high-entropy browser values. Only their fixed-length hashes
-- persist in D1; scanner GETs and database backups never contain a reusable credential.

ALTER TABLE app_sessions ADD COLUMN device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_app_sessions_device_active
  ON app_sessions (tenant_id, device_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS app_device_pairings (
  token_hash TEXT PRIMARY KEY CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE RESTRICT,
  issued_by_user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  issued_ip_hash TEXT NOT NULL CHECK (length(issued_ip_hash) = 64),
  issued_user_agent_hash TEXT NOT NULL CHECK (length(issued_user_agent_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_app_device_pairings_user_expiry
  ON app_device_pairings (tenant_id, user_id, expires_at, consumed_at, revoked_at);

CREATE TABLE IF NOT EXISTS app_devices (
  device_id TEXT PRIMARY KEY CHECK (
    length(device_id) BETWEEN 12 AND 80
    AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE RESTRICT,
  device_proof_hash TEXT NOT NULL UNIQUE CHECK (
    length(device_proof_hash) = 64 AND device_proof_hash NOT GLOB '*[^0-9a-f]*'
  ),
  paired_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES app_users(user_id) ON DELETE RESTRICT,
  created_ip_hash TEXT NOT NULL CHECK (length(created_ip_hash) = 64),
  created_user_agent_hash TEXT NOT NULL CHECK (length(created_user_agent_hash) = 64),
  CHECK (revoked_at IS NULL OR revoked_at >= paired_at)
);

CREATE INDEX IF NOT EXISTS idx_app_devices_tenant_user_active
  ON app_devices (tenant_id, user_id, revoked_at, paired_at DESC);
