-- 0066_dev_outbox_contract_acceptance.sql - widen the local-development capture kinds.
--
-- 0022 created dev_outbox so a local end-to-end stack could complete the REAL magic-link
-- sign-in without sending email. The customer contract-acceptance challenge (0029) is the
-- other half of the same problem and had no equivalent: its only delivery path is Gmail,
-- so the step-5 journey (customer opens the share link -> reviews the proposal -> accepts
-- the contract) was untraversable on a local stack even with every flag on.
--
-- This adds one capture kind. The writer and the reader both stay gated on
-- APP_ALLOW_INSECURE_LOCAL="true", which wrangler.jsonc pins to "false" in every deployed
-- environment, so production still has exactly one delivery path: Gmail.
--
-- SQLite cannot widen a CHECK in place, so the dev-only table is rebuilt. It is never
-- populated in a deployed environment, so the copy below is a no-op there.

CREATE TABLE IF NOT EXISTS dev_outbox_new (
  capture_id TEXT PRIMARY KEY CHECK (
    length(capture_id) BETWEEN 12 AND 80
    AND capture_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('magic_link', 'contract_acceptance')),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  href TEXT NOT NULL CHECK (length(href) BETWEEN 16 AND 2048),
  created_at TEXT NOT NULL
);

INSERT INTO dev_outbox_new (capture_id, kind, recipient, href, created_at)
SELECT capture_id, kind, recipient, href, created_at FROM dev_outbox;

DROP TABLE dev_outbox;

ALTER TABLE dev_outbox_new RENAME TO dev_outbox;

CREATE INDEX IF NOT EXISTS idx_dev_outbox_created ON dev_outbox (created_at DESC);
