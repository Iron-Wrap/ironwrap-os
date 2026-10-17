-- AI team shared memory: the fact-version ledger (Track A, AI-TEAM-CONTRACT.md "Citing facts").
--
-- A shared-memory fact is a canonical object, or the part of it a reviewer role may read, as an
-- exact value. The first time the Worker observes a value of a fact it records the next version
-- for that fact id with the value's hash; observing the same value again reuses that version. A
-- receipt's `{fact_id, version, hash}` therefore names one exact value, and any change to it moves
-- the version even where the source rows keep no aggregate counter. Only ids, versions, hashes and
-- times are kept here; values stay in the canonical rows.

CREATE TABLE IF NOT EXISTS agent_fact_versions (
  tenant_id TEXT NOT NULL,
  fact_id TEXT NOT NULL CHECK (length(fact_id) BETWEEN 3 AND 512),
  version INTEGER NOT NULL CHECK (version >= 1),
  hash TEXT NOT NULL CHECK (hash GLOB 'sha256:[0-9a-f]*' AND length(hash) = 71),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, fact_id, version)
);

CREATE TRIGGER IF NOT EXISTS prevent_agent_fact_version_update
BEFORE UPDATE ON agent_fact_versions
BEGIN
  SELECT RAISE(ABORT, 'agent_fact_versions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_agent_fact_version_delete
BEFORE DELETE ON agent_fact_versions
BEGIN
  SELECT RAISE(ABORT, 'agent_fact_versions_append_only');
END;

-- Versions are contiguous from 1, and a replacement insert cannot remove a recorded version (D1
-- runs with recursive_triggers off, so REPLACE would delete without firing the delete guard).
CREATE TRIGGER IF NOT EXISTS agent_fact_versions_sequence_guard
BEFORE INSERT ON agent_fact_versions
BEGIN
  SELECT RAISE(ABORT, 'agent_fact_versions_append_only')
   WHERE EXISTS (
     SELECT 1 FROM agent_fact_versions
      WHERE tenant_id = NEW.tenant_id AND fact_id = NEW.fact_id AND version = NEW.version
   )
      OR NEW.version <> COALESCE(
        (SELECT MAX(version) FROM agent_fact_versions WHERE tenant_id = NEW.tenant_id AND fact_id = NEW.fact_id),
        0
      ) + 1;
END;
