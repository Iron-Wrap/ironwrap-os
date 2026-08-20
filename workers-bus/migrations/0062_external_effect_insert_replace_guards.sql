-- 0062_external_effect_insert_replace_guards.sql - close the `INSERT OR REPLACE` bypass on the
-- 0042 external-effect ledger.
--
-- Follow-up to the PR #73 review (Multica ELEC-64 finding 1, ELEC-65 item 3). 0042 declares its
-- ledger append-only with `BEFORE UPDATE`/`BEFORE DELETE` triggers, and 0059-0061 mirrored that
-- shape - so when the money-plane tables turned out to be rewritable through `INSERT OR REPLACE`,
-- the question was whether the effect ledger is too. It is. Confirmed by running, against the real
-- 0042 schema on real D1 (workerd/miniflare, 2026-08-20):
--
--   DELETE FROM external_effect_attempts  -> external_effect_attempts_append_only  (refused)
--   REPLACE INTO external_effect_attempts -> succeeded; a terminal attempt's state, request_hash
--                                            and result_code were all rewritten
--
-- Why: `OR REPLACE` resolves a UNIQUE conflict by deleting the conflicting row internally, and an
-- internal delete only fires DELETE triggers when `PRAGMA recursive_triggers` is ON. It is OFF by
-- default on D1, and it is a per-connection setting: the Worker has no connection-open hook (only
-- `env.DB.prepare`), and `wrangler d1 execute` or a dashboard console session starts without it.
-- A guarantee that depends on it is a convention, not a structure.
--
-- A `BEFORE INSERT` trigger fires before conflict resolution, so it sees the row `OR REPLACE` is
-- about to delete and can refuse. That is what these four triggers do, and unlike the two-branch
-- guards in 0059/0060 they refuse every colliding insert outright: all four insert paths in
-- `effect-runtime.ts` are plain INSERTs whose colliding case already throws today
-- (`proposeExternalEffect` catches that throw and falls back to the idempotency-key lookup; the
-- exception path reads the live exception first). This migration therefore changes which error is
-- raised on a collision, never whether one is - and it changes `OR REPLACE` from silent rewrite to
-- refusal.
--
-- `external_effects` was in fact already refused in the probe above, but only incidentally: its
-- child rows hold `ON DELETE RESTRICT` foreign keys, so the internal delete failed on the FK
-- rather than on any rule of its own. That protection lasts exactly as long as a child row happens
-- to exist. It gets the same explicit guard as the other three.
--
-- Additive: no 0042 statement is edited, and no table, column or index is touched. Numbered above
-- `main` (0058), this PR's 0059-0061, and every open PR head as of 2026-08-20 (#22, #60, #70, #71,
-- #72 - highest 0057).

CREATE TRIGGER external_effects_no_insert_replace
BEFORE INSERT ON external_effects BEGIN
  SELECT RAISE(ABORT, 'external_effect_binding_immutable')
  WHERE EXISTS (
    SELECT 1 FROM external_effects e
     WHERE e.effect_id = NEW.effect_id
        OR (e.tenant_id = NEW.tenant_id AND e.idempotency_key = NEW.idempotency_key)
        OR (e.compensates_effect_id = NEW.compensates_effect_id
            AND NEW.compensates_effect_id IS NOT NULL)
  );
END;

CREATE TRIGGER external_effect_attempts_no_insert_replace
BEFORE INSERT ON external_effect_attempts BEGIN
  SELECT RAISE(ABORT, 'external_effect_attempts_append_only')
  WHERE EXISTS (
    SELECT 1 FROM external_effect_attempts a
     WHERE a.attempt_id = NEW.attempt_id
        OR (a.effect_id = NEW.effect_id AND a.attempt_number = NEW.attempt_number)
  );
END;

-- `UNIQUE (effect_id, event_type, attempt_id)` leaves the NULL-`attempt_id` rows unconstrained,
-- because SQLite treats NULLs in a unique index as distinct - and every event 0042 writes comes
-- from `external_effect_state_event` / `external_effect_proposed_event` with `attempt_id` NULL.
-- The `=` comparison below reproduces that exactly, so the ledger's own event writes never collide
-- with this guard; what it catches is a hand-written `REPLACE` that names an existing `event_seq`.
CREATE TRIGGER external_effect_events_no_insert_replace
BEFORE INSERT ON external_effect_events BEGIN
  SELECT RAISE(ABORT, 'external_effect_events_append_only')
  WHERE EXISTS (
    SELECT 1 FROM external_effect_events v
     WHERE v.event_seq = NEW.event_seq
        OR (v.effect_id = NEW.effect_id AND v.event_type = NEW.event_type
            AND v.attempt_id = NEW.attempt_id)
  );
END;

CREATE TRIGGER external_effect_exceptions_no_insert_replace
BEFORE INSERT ON external_effect_exceptions BEGIN
  SELECT RAISE(ABORT, 'external_effect_exceptions_retained')
  WHERE EXISTS (
    SELECT 1 FROM external_effect_exceptions x
     WHERE x.exception_id = NEW.exception_id
        OR (x.effect_id = NEW.effect_id AND x.reason_code = NEW.reason_code
            AND x.status = NEW.status)
  );
END;
