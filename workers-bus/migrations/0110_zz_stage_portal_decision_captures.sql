-- 0110_zz_stage_portal_decision_captures.sql - preserve portal captures across shipped 0111.
--
-- Wrangler applies every filename absent from d1_migrations in sorted order,
-- including a newly introduced lower-sorted filename. Stage the portal-only
-- rows before 0111 rebuilds dev_outbox with its historical three-kind CHECK.

CREATE TABLE IF NOT EXISTS dev_outbox_portal_0110_staging (
  capture_id TEXT PRIMARY KEY CHECK (
    length(capture_id) BETWEEN 12 AND 80
    AND capture_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  kind TEXT NOT NULL CHECK (kind = 'portal_decision_confirmation'),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  href TEXT NOT NULL CHECK (length(href) BETWEEN 16 AND 2048),
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO dev_outbox_portal_0110_staging (
  capture_id, kind, recipient, href, created_at
)
SELECT capture_id, kind, recipient, href, created_at
FROM dev_outbox
WHERE kind = 'portal_decision_confirmation';

DELETE FROM dev_outbox
WHERE kind = 'portal_decision_confirmation'
  AND EXISTS (
    SELECT 1
    FROM dev_outbox_portal_0110_staging staged
    WHERE staged.capture_id = dev_outbox.capture_id
      AND staged.kind = dev_outbox.kind
      AND staged.recipient = dev_outbox.recipient
      AND staged.href = dev_outbox.href
      AND staged.created_at = dev_outbox.created_at
  );
