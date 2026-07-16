-- 0018_customer_portal_links.sql - revocable, read-only customer project capabilities.
-- Raw bearer tokens never enter D1. A link is tenant/job/customer-bound so a later human
-- reassignment of the job fails closed at resolve time instead of widening old access.

CREATE TABLE IF NOT EXISTS customer_portal_links (
  link_id TEXT PRIMARY KEY CHECK (
    length(link_id) BETWEEN 12 AND 80
    AND link_id GLOB 'portal_[0-9a-f]*'
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 3 AND 140),
  customer_id TEXT NOT NULL CHECK (length(customer_id) BETWEEN 3 AND 140),
  issued_by_user_id TEXT NOT NULL CHECK (length(issued_by_user_id) BETWEEN 3 AND 80),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_user_id TEXT CHECK (revoked_by_user_id IS NULL OR length(revoked_by_user_id) BETWEEN 3 AND 80),
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  issued_ip_hash TEXT NOT NULL CHECK (length(issued_ip_hash) = 64),
  issued_user_agent_hash TEXT NOT NULL CHECK (length(issued_user_agent_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  FOREIGN KEY (issued_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_customer_portal_links_tenant_job_active
  ON customer_portal_links (tenant_id, roof_job_id, revoked_at, expires_at, created_at DESC);

-- Invalid capability attempts should not become unbounded D1 work. This is a separate table
-- because auth throttles have a closed enum of staff-auth scopes.
CREATE TABLE IF NOT EXISTS customer_portal_access_throttles (
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 64),
  window_started_at TEXT NOT NULL,
  window_expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 1000000),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ip_hash),
  CHECK (window_expires_at > window_started_at)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_customer_portal_access_throttles_expiry
  ON customer_portal_access_throttles (window_expires_at);
