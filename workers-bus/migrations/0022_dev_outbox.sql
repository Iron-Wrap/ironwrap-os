-- 0022_dev_outbox.sql - local-development message capture (never enabled in production).
-- Active only when APP_ALLOW_INSECURE_LOCAL="true" (localhost-only mode). It lets a local
-- end-to-end environment exercise the real magic-link / sign-in flow without sending real
-- email: the exact sign-in href is captured here and read back through GET /admin/dev-outbox.
-- Production deployments keep APP_ALLOW_INSECURE_LOCAL="false", which disables both the
-- writer and the reader of this table.

CREATE TABLE IF NOT EXISTS dev_outbox (
  capture_id TEXT PRIMARY KEY CHECK (
    length(capture_id) BETWEEN 12 AND 80
    AND capture_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('magic_link')),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  href TEXT NOT NULL CHECK (length(href) BETWEEN 16 AND 2048),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_outbox_created ON dev_outbox (created_at DESC);
