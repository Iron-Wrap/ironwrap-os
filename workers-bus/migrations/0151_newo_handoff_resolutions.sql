-- 0151_newo_handoff_resolutions.sql - a person resolves one failed Newo handoff.
--
-- A failed handoff (`newo_sessions.handoff_status = 'failed'`) is a caller who asked for a person
-- and was not put through. The Newo reconcile and the operations read model count a failed
-- handoff until a person records how it ended. There is no lookback window: a window would retire
-- a failure that nobody decided. This append-only record is that decision. It names the failed
-- session it resolves, the person who resolved it (`resolved_by`, their user id) and the role they
-- held at that moment, when (`resolved_at`), the outcome (`called_back`, `unreachable` or
-- `not_needed`), an optional note, and the Idempotency-Key and request hash that make a retry
-- exact.
--
-- Resolving is people-only: the Worker admits it only from a person's own cookie session in the
-- owner or ops role, the roles that already read Newo operations. This table repeats what the
-- database can see: an active owner or ops user of the same tenant under their current role, and
-- a session whose handoff is failed at that moment. A tenant records at most one resolution per
-- failed handoff. The two UNIQUE keys serve every lookup, so the table adds no named index.

CREATE TABLE IF NOT EXISTS newo_handoff_resolutions (
  resolution_id TEXT PRIMARY KEY CHECK (
    length(resolution_id) = 36
    AND substr(resolution_id, 1, 4) = 'nhr_'
    AND substr(resolution_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 140
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  session_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('called_back', 'unreachable', 'not_needed')),
  note TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  resolved_by TEXT NOT NULL,
  resolved_by_role TEXT NOT NULL CHECK (resolved_by_role IN ('owner', 'ops')),
  resolved_at TEXT NOT NULL CHECK (length(resolved_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, session_id),
  FOREIGN KEY (session_id) REFERENCES newo_sessions(session_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_by, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TRIGGER newo_handoff_resolutions_validate_insert
BEFORE INSERT ON newo_handoff_resolutions
BEGIN
  -- Only a failed handoff can be resolved, and it must still be failed when the person resolves it.
  SELECT RAISE(ABORT, 'newo_handoff_resolution_not_failed')
  WHERE NOT EXISTS (
    SELECT 1
      FROM newo_sessions session
     WHERE session.session_id = NEW.session_id
       AND session.handoff_status = 'failed'
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
END;

CREATE TRIGGER newo_handoff_resolutions_append_only_update
BEFORE UPDATE ON newo_handoff_resolutions
BEGIN
  SELECT RAISE(ABORT, 'newo_handoff_resolution_append_only');
END;

CREATE TRIGGER newo_handoff_resolutions_append_only_delete
BEFORE DELETE ON newo_handoff_resolutions
BEGIN
  SELECT RAISE(ABORT, 'newo_handoff_resolution_append_only');
END;

-- REPLACE would delete an earlier resolution before inserting; refuse any conflicting key first.
-- Created last, so it fires first: a second resolution of the same handoff is refused as already
-- resolved even after the session's handoff status has moved on.
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
