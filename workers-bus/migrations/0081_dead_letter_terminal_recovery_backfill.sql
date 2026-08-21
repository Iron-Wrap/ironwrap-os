-- 0081_dead_letter_terminal_recovery_backfill.sql - close the dead-letter rows the terminal
-- skip paths never closed (ELEC-137 defect 3 / IRO-194).
--
-- Data-only repair: no table, index, or trigger is created, altered, or dropped, so the D1 schema
-- inventory that deploy/backup-d1-to-r2.sh, deploy/restore-d1-from-r2.sh and
-- tools/production-readiness.mjs pin is unchanged by this file.
--
-- Why it is needed. handlePush marks an envelope's dead-letter rows recovered when it reaches
-- `pushed`, and its idempotency guard does the same for a re-delivered envelope already sitting on
-- any terminal status. Two terminal exits did not: the JOBNIMBUS_ENABLED=false skip (`jn_skipped`)
-- and the missing-credential skip (`erpnext_no_token`). Both are fixed forward in this change, but
-- every row they already stranded stays `recovered = 0` forever, because the auto-replay sweep only
-- reconsiders envelopes whose status is still 'dead'. Those rows keep GET /admin/status reporting
-- "degraded" with an inflated open_dead_letters count long after the envelope healed, and — worse —
-- they poison the episode boundary the sweep's attempt cap is now scoped to: a stale open row from
-- a resolved outage would anchor `dead_since` in the past, so a future unrelated death would
-- inherit the spent attempts this change exists to stop inheriting.
--
-- Scope. Exactly the four statuses handlePush's own idempotency guard already treats as recovered.
-- Envelopes that are currently 'dead', 'duplicate', or still in flight are deliberately untouched,
-- as are dead_letter rows with no envelope_id (the measurement-processing incidents keyed on a
-- receipt id, which this envelope join cannot and must not match).
--
-- Idempotent and additive: re-running it closes nothing further, and it never reopens a row.

UPDATE dead_letter
   SET recovered = 1
 WHERE recovered = 0
   AND envelope_id IS NOT NULL
   AND envelope_id IN (
     SELECT envelope_id
       FROM envelopes
      WHERE status IN ('pushed', 'reconciled', 'jn_skipped', 'erpnext_no_token')
   );
