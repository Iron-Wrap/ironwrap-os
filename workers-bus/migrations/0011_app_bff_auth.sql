-- 0011_app_bff_auth.sql - tenant-bound PWA users, passwordless auth, and auth audit.
-- Raw magic-link and session tokens are never persisted; only fixed-length hashes are stored.

CREATE TABLE IF NOT EXISTS app_users (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 12 AND 80),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  email_normalized TEXT NOT NULL CHECK (
    length(email_normalized) BETWEEN 3 AND 254
    AND email_normalized = lower(trim(email_normalized))
    AND instr(email_normalized, '@') > 1
  ),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  role TEXT NOT NULL CHECK (role IN ('owner', 'ops', 'field')),
  frappe_user_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 3 AND 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, email_normalized),
  UNIQUE (user_id, tenant_id),
  CHECK (
    role != 'field'
    OR (frappe_user_id IS NOT NULL AND length(trim(frappe_user_id)) BETWEEN 3 AND 140)
  )
);

CREATE INDEX IF NOT EXISTS idx_app_users_tenant_role_active
  ON app_users (tenant_id, active, role, updated_at);

CREATE TABLE IF NOT EXISTS app_magic_links (
  token_hash TEXT PRIMARY KEY CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  request_ip_hash TEXT NOT NULL CHECK (length(request_ip_hash) = 64),
  request_user_agent_hash TEXT NOT NULL CHECK (length(request_user_agent_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  UNIQUE (user_id),
  FOREIGN KEY (user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_magic_links_user_expiry
  ON app_magic_links (user_id, expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS app_sessions (
  session_hash TEXT PRIMARY KEY CHECK (
    length(session_hash) = 64 AND session_hash NOT GLOB '*[^0-9a-f]*'
  ),
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT NOT NULL,
  created_ip_hash TEXT NOT NULL CHECK (length(created_ip_hash) = 64),
  created_user_agent_hash TEXT NOT NULL CHECK (length(created_user_agent_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  FOREIGN KEY (user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_user_expiry
  ON app_sessions (user_id, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS app_auth_throttles (
  key_hash TEXT PRIMARY KEY CHECK (
    length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  scope TEXT NOT NULL CHECK (scope IN ('request_email', 'request_ip', 'consume_ip')),
  window_started_at TEXT NOT NULL,
  window_expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 1000000),
  updated_at TEXT NOT NULL,
  CHECK (window_expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_app_auth_throttles_expiry
  ON app_auth_throttles (window_expires_at);

CREATE TABLE IF NOT EXISTS app_auth_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  tenant_id TEXT,
  user_id TEXT REFERENCES app_users(user_id) ON DELETE SET NULL,
  event TEXT NOT NULL CHECK (length(event) BETWEEN 3 AND 64),
  outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 2 AND 64),
  ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 64),
  user_agent_hash TEXT NOT NULL CHECK (length(user_agent_hash) = 64),
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) <= 120)
);

CREATE INDEX IF NOT EXISTS idx_app_auth_audit_tenant_created
  ON app_auth_audit (tenant_id, created_at DESC);
