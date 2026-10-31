-- AI team: signal text retention (Track A, AI-TEAM-CONTRACT.md "The inbound signal" and
-- "Signal text retention", COMPLIANCE-REGISTER.md minimisation and destruction).
--
-- A signal is append-only (0200). One exception: ninety days after it was received, the free text a
-- person or a specialist wrote into a signal is redacted in place, once (agents/retention.ts
-- `redactSignalText`, SIGNAL_TEXT_RETENTION_DAYS). An inbound event loses its excerpt, its form
-- fields and its service; a person's ask its question; a handoff its reason. Each keeps its ids,
-- roles, envelope, channel, objects and expected action, and gains `"redacted": true`, so it can
-- never be redacted again. A watch holds the Worker's own records and is never redacted. The row
-- keeps its original content_sha256: it still proves what was received, and every receipt that cited
-- the signal still names the same hash. The trigger body is 0200's plus that one exception; the
-- age is read on D1's clock in the stored ISO form, so the code cannot redact a younger signal
-- (the trigger is the floor). kind and received_at are NOT NULL and every other comparison is
-- null-safe (IS), so a NULL can never switch the exception on.

DROP TRIGGER IF EXISTS prevent_agent_signal_update;

CREATE TRIGGER IF NOT EXISTS prevent_agent_signal_update
BEFORE UPDATE ON agent_signals
WHEN NOT (
    OLD.kind IN ('event', 'owner_request', 'handoff')
    AND json_extract(OLD.content_json, '$.redacted') IS NULL
    AND OLD.received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
    AND NEW.content_json IS CASE OLD.kind
      WHEN 'event' THEN json_set(json_remove(OLD.content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('true'))
      WHEN 'owner_request' THEN json_set(json_remove(OLD.content_json, '$.question'), '$.redacted', json('true'))
      WHEN 'handoff' THEN json_set(json_remove(OLD.content_json, '$.reason'), '$.redacted', json('true'))
    END
    AND NEW.signal_seq IS OLD.signal_seq
    AND NEW.signal_id IS OLD.signal_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.kind IS OLD.kind
    AND NEW.specialist_id IS OLD.specialist_id
    AND NEW.watch_id IS OLD.watch_id
    AND NEW.source IS OLD.source
    AND NEW.subject_aggregate IS OLD.subject_aggregate
    AND NEW.subject_id IS OLD.subject_id
    AND NEW.content_sha256 IS OLD.content_sha256
    AND NEW.dedupe_key IS OLD.dedupe_key
    AND NEW.parent_run_id IS OLD.parent_run_id
    AND NEW.handoff_depth IS OLD.handoff_depth
    AND NEW.received_at IS OLD.received_at
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_signals_append_only');
END;

-- The signals still holding their text, oldest first, so the daily redaction reads only those:
-- a redacted signal leaves the index.
CREATE INDEX IF NOT EXISTS idx_agent_signals_unredacted ON agent_signals (tenant_id, received_at)
  WHERE kind IN ('event', 'owner_request', 'handoff') AND json_extract(content_json, '$.redacted') IS NULL;
