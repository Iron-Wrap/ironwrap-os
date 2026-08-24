-- 0114_dev_outbox_capture_kinds.sql - preserve every local-only auth/portal capture kind.
--
-- 0107 introduced portal_decision_confirmation and 0111 introduced user_invite. Both migrations
-- rebuild SQLite's CHECK-constrained dev_outbox table, so this forward migration restores their
-- combined contract without rewriting the already-merged 0111 history.

CREATE TABLE IF NOT EXISTS dev_outbox_0114 (
  capture_id TEXT PRIMARY KEY CHECK (
    length(capture_id) BETWEEN 12 AND 80
    AND capture_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('magic_link', 'contract_acceptance', 'portal_decision_confirmation', 'user_invite')
  ),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  href TEXT NOT NULL CHECK (length(href) BETWEEN 16 AND 2048),
  created_at TEXT NOT NULL
);

INSERT INTO dev_outbox_0114 (capture_id, kind, recipient, href, created_at)
SELECT capture_id, kind, recipient, href, created_at FROM dev_outbox;

DROP TABLE dev_outbox;

ALTER TABLE dev_outbox_0114 RENAME TO dev_outbox;

CREATE INDEX IF NOT EXISTS idx_dev_outbox_created ON dev_outbox (created_at DESC);
