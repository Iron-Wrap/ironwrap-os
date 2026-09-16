-- The durable acknowledgement ledger for the independent release issuer (IRO-219).
--
-- One row per exact request digest, append-only. The replay rule in LAUNCH-RUNBOOK depends on this
-- table being the only place a run id is minted: an exact still-valid replay reads the row back,
-- and an expired one is refused rather than re-acknowledged.

CREATE TABLE IF NOT EXISTS independent_issuer_acknowledgements (
  request_digest TEXT PRIMARY KEY CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  repository TEXT NOT NULL CHECK (length(repository) BETWEEN 3 AND 140),
  phase TEXT NOT NULL CHECK (phase IN ('review', 'release-evidence')),
  source_commit TEXT NOT NULL CHECK (
    length(source_commit) = 40 AND source_commit NOT GLOB '*[^0-9a-f]*'
  ),
  issuer_principal TEXT NOT NULL CHECK (length(issuer_principal) BETWEEN 3 AND 320),
  issuer_task_id TEXT NOT NULL CHECK (length(issuer_task_id) BETWEEN 3 AND 256),
  issuer_run_id TEXT NOT NULL CHECK (length(issuer_run_id) BETWEEN 3 AND 256),
  key_version TEXT NOT NULL CHECK (length(key_version) BETWEEN 3 AND 256),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  acknowledgement_json TEXT NOT NULL CHECK (length(acknowledgement_json) BETWEEN 2 AND 8192)
);

CREATE INDEX IF NOT EXISTS independent_issuer_acknowledgements_by_source
  ON independent_issuer_acknowledgements (source_commit, accepted_at);

-- Append-only. An acknowledgement the reviewer has already been bound to must not be edited into
-- naming a different run, and must not disappear while a release is waiting on it.
CREATE TRIGGER IF NOT EXISTS independent_issuer_acknowledgements_append_only_update
BEFORE UPDATE ON independent_issuer_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'independent_issuer_acknowledgements_append_only');
END;

CREATE TRIGGER IF NOT EXISTS independent_issuer_acknowledgements_append_only_delete
BEFORE DELETE ON independent_issuer_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'independent_issuer_acknowledgements_retained');
END;
