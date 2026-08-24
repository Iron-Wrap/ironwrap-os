-- 0114_zz_restore_portal_decision_captures.sql - restore captures staged before shipped 0111.
--
-- 0114 has restored the combined four-kind dev_outbox CHECK. Reinsert the
-- exact staged rows, then remove the staging table only after every insert
-- succeeds. A capture-id conflict aborts and retains the staged authority.

INSERT INTO dev_outbox (capture_id, kind, recipient, href, created_at)
SELECT capture_id, kind, recipient, href, created_at
FROM dev_outbox_portal_0110_staging;

DROP TABLE dev_outbox_portal_0110_staging;
