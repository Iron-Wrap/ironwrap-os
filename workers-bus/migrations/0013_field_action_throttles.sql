-- 0013_field_action_throttles.sql - pre-body rate limiting for authenticated field uploads.
-- One compact row per user/scope resets when its window expires and is removed by scheduled cleanup.

CREATE TABLE IF NOT EXISTS app_action_throttles (
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('field_upload')),
  window_started_at TEXT NOT NULL,
  window_expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, scope),
  CHECK (window_expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_app_action_throttles_expiry
  ON app_action_throttles (window_expires_at);
