-- 0168_newo_callback_records.sql - the D1 record of a callback a Newo caller is owed, closed by a
-- person.
--
-- The receptionist is callback only (owner decisions MD-05 and D-03): a caller who wants a person
-- is called back, never put through. So a requested callback is the only way such a caller
-- reaches a person, and it needs an owned record, not only a session row that later events update
-- and an owner email sent on a best-effort basis. The Worker writes one append-only row per Newo
-- session, in the same D1 batch as the session write, when an accepted event leaves the session's
-- handoff `requested` (the receptionist asked for a callback) or `failed` (the request did not
-- arrive or could not be processed, including an emergency call that closed without one). The row
-- names the tenant, the session, the event that opened it, the handoff status and urgency at that
-- moment, the reason the receptionist gave, and the caller's contact details as the session knew
-- them, which are the details the owner email already carries. D1 stamps `recorded_at` from its
-- own clock; a time the caller supplies is refused.
--
-- A person closes it with the 0151 resolution: one append-only `newo_handoff_resolutions` row per
-- session, written only from a person's own cookie session in the owner or ops role. 0151's insert
-- trigger admitted only a failed handoff. This file re-creates it under its name so it also admits
-- a requested callback: a session whose handoff is `failed` or `requested` now, or one that has a
-- callback record (an event that arrives after a newer one does not update the session row, but
-- its record is still written). It also requires a note, and it requires `resolved_at` to be D1's
-- own clock. The actor check is 0151's, unchanged. The 0151 no-replace guard is re-created after
-- it, unchanged, so it still fires first and a second resolution of one session is refused as
-- already resolved.
--
-- The two UNIQUE keys serve every lookup, so the table adds no named index. Higher-numbered
-- migrations (0200-0206) touch only agent_* objects, and no migration after 0151 touches the
-- newo_handoff_resolutions triggers, so this file applies the same before or after them.

CREATE TABLE IF NOT EXISTS newo_callback_records (
  callback_id TEXT PRIMARY KEY CHECK (
    length(callback_id) = 36
    AND substr(callback_id, 1, 4) = 'ncb_'
    AND substr(callback_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  handoff_status TEXT NOT NULL CHECK (handoff_status IN ('requested', 'failed')),
  urgency TEXT NOT NULL CHECK (urgency IN ('routine', 'urgent', 'emergency')),
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
  contact_name TEXT CHECK (contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 160),
  contact_phone TEXT CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 1 AND 40),
  contact_email TEXT CHECK (contact_email IS NULL OR length(contact_email) BETWEEN 3 AND 254),
  address_line1 TEXT CHECK (address_line1 IS NULL OR length(address_line1) BETWEEN 1 AND 240),
  city TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 120),
  province TEXT CHECK (province IS NULL OR length(province) BETWEEN 1 AND 80),
  postal_code TEXT CHECK (postal_code IS NULL OR length(postal_code) BETWEEN 1 AND 24),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, session_id),
  FOREIGN KEY (session_id) REFERENCES newo_sessions(session_id) ON DELETE RESTRICT
);

CREATE TRIGGER newo_callback_records_validate_insert
BEFORE INSERT ON newo_callback_records
BEGIN
  -- D1's clock, not the Worker's or the caller's. 'now' is the same for the whole statement, so
  -- the column default and this check agree.
  SELECT RAISE(ABORT, 'newo_callback_record_clock_invalid')
  WHERE NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

  -- The event that opens the record is one the Worker claimed for this session.
  SELECT RAISE(ABORT, 'newo_callback_record_event_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM newo_event_receipts receipt
     WHERE receipt.event_id = NEW.event_id
       AND receipt.session_id = NEW.session_id
  );
END;

CREATE TRIGGER newo_callback_records_append_only_update
BEFORE UPDATE ON newo_callback_records
BEGIN
  SELECT RAISE(ABORT, 'newo_callback_record_append_only');
END;

CREATE TRIGGER newo_callback_records_append_only_delete
BEFORE DELETE ON newo_callback_records
BEGIN
  SELECT RAISE(ABORT, 'newo_callback_record_append_only');
END;

-- REPLACE would delete the earlier record before inserting; refuse any conflicting key first.
-- Created last, so it fires first.
CREATE TRIGGER newo_callback_records_no_insert_replace
BEFORE INSERT ON newo_callback_records
BEGIN
  SELECT RAISE(ABORT, 'newo_callback_record_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM newo_callback_records existing
     WHERE existing.callback_id = NEW.callback_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.session_id = NEW.session_id)
  );
END;

-- 0151's insert guard and no-replace guard, re-created in 0151's order so the no-replace guard
-- still fires first.
DROP TRIGGER IF EXISTS newo_handoff_resolutions_no_insert_replace;
DROP TRIGGER IF EXISTS newo_handoff_resolutions_validate_insert;

CREATE TRIGGER newo_handoff_resolutions_validate_insert
BEFORE INSERT ON newo_handoff_resolutions
BEGIN
  -- A person closes a failed handoff or a requested callback, and nothing else.
  SELECT RAISE(ABORT, 'newo_handoff_resolution_not_open')
  WHERE NOT EXISTS (
    SELECT 1
      FROM newo_sessions session
     WHERE session.session_id = NEW.session_id
       AND session.handoff_status IN ('failed', 'requested')
  )
    AND NOT EXISTS (
    SELECT 1
      FROM newo_callback_records callback
     WHERE callback.tenant_id = NEW.tenant_id
       AND callback.session_id = NEW.session_id
  );

  -- The resolver is an active owner or ops user of this tenant and holds the recorded role right now.
  SELECT RAISE(ABORT, 'newo_handoff_resolution_actor_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.resolved_by
       AND actor.active = 1
       AND actor.access_role = NEW.resolved_by_role
  );

  -- How it ended, in the person's words. The 0151 CHECK keeps a present note to 1-1000 characters.
  SELECT RAISE(ABORT, 'newo_handoff_resolution_note_required')
  WHERE NEW.note IS NULL;

  -- D1's clock, not the Worker's.
  SELECT RAISE(ABORT, 'newo_handoff_resolution_clock_invalid')
  WHERE NEW.resolved_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER newo_handoff_resolutions_no_insert_replace
BEFORE INSERT ON newo_handoff_resolutions
BEGIN
  SELECT RAISE(ABORT, 'newo_handoff_resolution_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM newo_handoff_resolutions existing
     WHERE existing.resolution_id = NEW.resolution_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.idempotency_key = NEW.idempotency_key)
  );
  SELECT RAISE(ABORT, 'newo_handoff_already_resolved')
  WHERE EXISTS (
    SELECT 1
      FROM newo_handoff_resolutions existing
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.session_id = NEW.session_id
  );
END;
