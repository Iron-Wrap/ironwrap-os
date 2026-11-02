-- 0165_safety_stop_raiser_guard.sql - the person who raised a safety-occurrence stop never lifts it
-- (owner rule L06, with no exception for working alone), and a lift never stands without its
-- journal entry.
--
-- Under 0047 any active owner, ops or production user could lift a stop (`stop_active` 1 -> 0) once
-- the event was controlled and any required rescue was complete, including the person who reported
-- it. The occurrence row could not say who lifted it, because the Worker wrote the `released` event
-- in a second, separate statement after the lift. A Work Package stop already refuses its raiser
-- (0145, re-created by 0152). This migration applies the same rule to a safety occurrence.
--
-- `released_by_user_id` names the person who lifted the stop. The lift sets it in the same
-- statement, and nothing changes it afterwards. The Worker now writes the `released` event first
-- and lifts the stop in the same batch, so a lift can require that person's own `released` event
-- for the exact version the occurrence moves to: no stop is lifted without a journal entry. That
-- event's own insert guard (0047) already requires its actor to hold the owner, ops or production
-- role at that moment.
--
-- A lift is refused when it names nobody, because an unnamed releaser cannot be shown not to be the
-- raiser. It is refused when it names no active user of this tenant, and when it names a person who
-- shares any identity with the reporter: user id, email or Frappe user, compared both ways exactly
-- as 0145 compares a Work Package stop's releaser. There is no solo exception: if nobody else can
-- lift the stop, it stays active.
--
-- This is a new trigger, so 0047's guards stay exactly as shipped. Triggers on one table fire
-- newest first, so a lift by the raiser reports this refusal before 0047's control and rescue
-- checks. A stop lifted before this migration keeps a NULL `released_by_user_id`; its `released`
-- event names who lifted it. Adds one column and one trigger.

ALTER TABLE safety_occurrences ADD COLUMN released_by_user_id TEXT;

CREATE TRIGGER safety_occurrences_stop_release_guard
BEFORE UPDATE ON safety_occurrences
BEGIN
  -- Only a lift names who lifted the stop, and the name never changes afterwards.
  SELECT RAISE(ABORT, 'safety_stop_releaser_immutable')
  WHERE NEW.released_by_user_id IS NOT OLD.released_by_user_id
    AND NOT (OLD.stop_active = 1 AND NEW.stop_active = 0);

  SELECT RAISE(ABORT, 'safety_stop_releaser_required')
  WHERE OLD.stop_active = 1 AND NEW.stop_active = 0
    AND NEW.released_by_user_id IS NULL;

  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE OLD.stop_active = 1 AND NEW.stop_active = 0
    AND NOT EXISTS (
      SELECT 1
        FROM app_users releaser
       WHERE releaser.tenant_id = NEW.tenant_id
         AND releaser.user_id = NEW.released_by_user_id
         AND releaser.active = 1
    );

  -- Never the person who raised the stop, under any identity either of them carries.
  SELECT RAISE(ABORT, 'safety_stop_release_by_raiser_forbidden')
  WHERE OLD.stop_active = 1 AND NEW.stop_active = 0
    AND EXISTS (
      SELECT 1
        FROM app_users releaser
       WHERE releaser.tenant_id = NEW.tenant_id
         AND releaser.user_id = NEW.released_by_user_id
         AND (
           lower(trim(NEW.reported_by_user_id)) IN (
             lower(releaser.user_id), releaser.email_normalized, lower(trim(releaser.frappe_user_id))
           )
           OR EXISTS (
             SELECT 1
               FROM app_users raiser
              WHERE raiser.tenant_id = NEW.tenant_id
                AND raiser.user_id = NEW.reported_by_user_id
                AND (
                  lower(raiser.user_id) IN (
                    lower(releaser.user_id), releaser.email_normalized,
                    lower(trim(releaser.frappe_user_id))
                  )
                  OR raiser.email_normalized IN (
                    lower(releaser.user_id), releaser.email_normalized,
                    lower(trim(releaser.frappe_user_id))
                  )
                  OR lower(trim(raiser.frappe_user_id)) IN (
                    lower(releaser.user_id), releaser.email_normalized,
                    lower(trim(releaser.frappe_user_id))
                  )
                )
           )
         )
    );

  -- The releaser's own `released` event for the version this lift moves to is already written.
  SELECT RAISE(ABORT, 'safety_stop_release_event_required')
  WHERE OLD.stop_active = 1 AND NEW.stop_active = 0
    AND NOT EXISTS (
      SELECT 1
        FROM safety_occurrence_events event
       WHERE event.tenant_id = NEW.tenant_id
         AND event.occurrence_id = NEW.occurrence_id
         AND event.occurrence_version = NEW.version
         AND event.event_kind = 'released'
         AND event.actor_user_id = NEW.released_by_user_id
    );
END;
