-- 0127_pipeline_automation_action_registry.sql - widen the closed automation action registry
-- (IRO-244 / IRO-209).
--
-- 0123 pinned `action` and `template_key` to one literal value each with column CHECK constraints.
-- The registry is still CLOSED, but it now holds a second registered action: a rule may ask for a
-- document to be generated from a document template (0125) and delivered through the same governed
-- email rail.  SQLite cannot widen a CHECK in place, so - exactly as 0114 did for `dev_outbox` -
-- both CHECK-constrained tables are rebuilt forward.  No column is dropped, no row is discarded,
-- and the object inventory (2 tables, 3 indexes, 6 triggers) is restored byte-for-byte apart from
-- the widened constraints.
--
-- Nothing here names a vertical.  "Which document" is a template row an administrator authors, not
-- a code path: the pairing CHECK only says that the built-in summary action keeps its built-in
-- template, and that the document action carries a document-template identifier.

DROP TRIGGER IF EXISTS pipeline_automation_rule_heads_identity_guard;
DROP TRIGGER IF EXISTS pipeline_automation_rule_revisions_lineage_guard;
DROP TRIGGER IF EXISTS pipeline_automation_rule_revisions_append_only_update;
DROP TRIGGER IF EXISTS pipeline_automation_rule_revisions_append_only_delete;
DROP TRIGGER IF EXISTS pipeline_automation_rule_revisions_no_insert_replace;
DROP TRIGGER IF EXISTS pipeline_stage_automation_invocations_identity_guard;
DROP TRIGGER IF EXISTS pipeline_stage_automation_invocations_append_only_delete;

CREATE TABLE pipeline_automation_rule_revisions_0127 (
  revision_id TEXT PRIMARY KEY CHECK (
    length(revision_id) BETWEEN 12 AND 200
    AND revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  prior_revision_id TEXT,
  pipeline_id TEXT NOT NULL,
  to_stage_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('operations.email.send', 'operations.document.generate_and_send')
  ),
  recipient_ref TEXT NOT NULL CHECK (length(recipient_ref) BETWEEN 1 AND 120),
  template_key TEXT NOT NULL CHECK (
    length(template_key) BETWEEN 1 AND 220
    AND template_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  template_version INTEGER NOT NULL CHECK (template_version BETWEEN 1 AND 1000000),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  actor_role TEXT NOT NULL CHECK (length(actor_role) BETWEEN 2 AND 40),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (revision_id, tenant_id),
  UNIQUE (tenant_id, rule_id, version),
  CHECK (
    (action = 'operations.email.send'
      AND template_key = 'pipeline.stage-change-summary'
      AND template_version = 1)
    OR (action = 'operations.document.generate_and_send'
      AND template_key != 'pipeline.stage-change-summary'
      AND length(template_key) BETWEEN 12 AND 220)
  ),
  FOREIGN KEY (rule_id, tenant_id)
    REFERENCES pipeline_automation_rule_heads(rule_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_id, tenant_id)
    REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_stage_id, tenant_id, pipeline_id)
    REFERENCES pipeline_stages(stage_id, tenant_id, pipeline_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_revision_id, tenant_id)
    REFERENCES pipeline_automation_rule_revisions_0127(revision_id, tenant_id) ON DELETE RESTRICT
);

INSERT INTO pipeline_automation_rule_revisions_0127 (
  revision_id, tenant_id, rule_id, version, prior_revision_id, pipeline_id, to_stage_id,
  action, recipient_ref, template_key, template_version, active, actor_role, actor_id, created_at
)
SELECT revision_id, tenant_id, rule_id, version, prior_revision_id, pipeline_id, to_stage_id,
       action, recipient_ref, template_key, template_version, active, actor_role, actor_id, created_at
  FROM pipeline_automation_rule_revisions
 ORDER BY version ASC;

CREATE TABLE pipeline_stage_automation_invocations_0127 (
  invocation_id TEXT PRIMARY KEY CHECK (
    length(invocation_id) BETWEEN 12 AND 200
    AND invocation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  outbox_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_revision_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL CHECK (rule_version BETWEEN 1 AND 1000000),
  action TEXT NOT NULL CHECK (
    action IN ('operations.email.send', 'operations.document.generate_and_send')
  ),
  recipient_ref TEXT NOT NULL CHECK (length(recipient_ref) BETWEEN 1 AND 120),
  recipient_digest TEXT CHECK (
    recipient_digest IS NULL OR (length(recipient_digest) = 64 AND recipient_digest NOT GLOB '*[^0-9a-f]*')
  ),
  template_key TEXT NOT NULL CHECK (
    length(template_key) BETWEEN 1 AND 220
    AND template_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  template_version INTEGER NOT NULL CHECK (template_version BETWEEN 1 AND 1000000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'claimed', 'retry', 'succeeded', 'failed', 'unknown')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_ref TEXT,
  lease_expires_at TEXT,
  effect_id TEXT,
  effect_state TEXT,
  provider_external_id TEXT,
  provider_response_hash TEXT CHECK (
    provider_response_hash IS NULL OR (length(provider_response_hash) = 64 AND provider_response_hash NOT GLOB '*[^0-9a-f]*')
  ),
  readback_hash TEXT CHECK (
    readback_hash IS NULL OR (length(readback_hash) = 64 AND readback_hash NOT GLOB '*[^0-9a-f]*')
  ),
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  completed_at TEXT,
  UNIQUE (invocation_id, tenant_id),
  UNIQUE (tenant_id, outbox_id),
  CHECK (
    (action = 'operations.email.send'
      AND template_key = 'pipeline.stage-change-summary'
      AND template_version = 1)
    OR (action = 'operations.document.generate_and_send'
      AND template_key != 'pipeline.stage-change-summary'
      AND length(template_key) BETWEEN 12 AND 220)
  ),
  FOREIGN KEY (outbox_id, tenant_id)
    REFERENCES pipeline_stage_automation_outbox(outbox_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_id, tenant_id)
    REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (transition_id, tenant_id, pipeline_id)
    REFERENCES pipeline_card_transitions(transition_id, tenant_id, pipeline_id) ON DELETE RESTRICT,
  FOREIGN KEY (rule_id, tenant_id)
    REFERENCES pipeline_automation_rule_heads(rule_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (rule_revision_id, tenant_id)
    REFERENCES pipeline_automation_rule_revisions_0127(revision_id, tenant_id) ON DELETE RESTRICT
);

INSERT INTO pipeline_stage_automation_invocations_0127 (
  invocation_id, tenant_id, outbox_id, pipeline_id, transition_id, rule_id, rule_revision_id,
  rule_version, action, recipient_ref, recipient_digest, template_key, template_version, status,
  attempt_count, lease_ref, lease_expires_at, effect_id, effect_state, provider_external_id,
  provider_response_hash, readback_hash, result_code, created_at, updated_at, completed_at
)
SELECT invocation_id, tenant_id, outbox_id, pipeline_id, transition_id, rule_id, rule_revision_id,
       rule_version, action, recipient_ref, recipient_digest, template_key, template_version, status,
       attempt_count, lease_ref, lease_expires_at, effect_id, effect_state, provider_external_id,
       provider_response_hash, readback_hash, result_code, created_at, updated_at, completed_at
  FROM pipeline_stage_automation_invocations;

DROP TABLE pipeline_stage_automation_invocations;

-- The old revision table references itself through `prior_revision_id`.  Its append-only guards are
-- already dropped above, so the lineage pointer is cleared here purely to let the implicit
-- `DELETE FROM` inside `DROP TABLE` run without tripping the self-referencing foreign key.  The
-- lineage itself is already preserved in the replacement table.
UPDATE pipeline_automation_rule_revisions SET prior_revision_id = NULL;

DROP TABLE pipeline_automation_rule_revisions;

ALTER TABLE pipeline_automation_rule_revisions_0127 RENAME TO pipeline_automation_rule_revisions;
ALTER TABLE pipeline_stage_automation_invocations_0127 RENAME TO pipeline_stage_automation_invocations;

CREATE INDEX IF NOT EXISTS idx_pipeline_automation_rule_revisions_pipeline
  ON pipeline_automation_rule_revisions (tenant_id, pipeline_id, to_stage_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_stage_automation_invocations_due
  ON pipeline_stage_automation_invocations (tenant_id, status, lease_expires_at, updated_at, invocation_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_stage_automation_invocations_effect
  ON pipeline_stage_automation_invocations (tenant_id, effect_id);

CREATE TRIGGER pipeline_automation_rule_heads_identity_guard
BEFORE UPDATE ON pipeline_automation_rule_heads
BEGIN
  SELECT RAISE(ABORT, 'pipeline_automation_rule_head_identity_immutable')
    WHERE NEW.rule_id != OLD.rule_id OR NEW.tenant_id != OLD.tenant_id
       OR NEW.pipeline_id != OLD.pipeline_id OR NEW.to_stage_id != OLD.to_stage_id
       OR NEW.created_by != OLD.created_by OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'pipeline_automation_rule_head_version_conflict')
    WHERE NEW.current_version != OLD.current_version + 1;
  SELECT RAISE(ABORT, 'pipeline_automation_rule_head_pointer_invalid')
    WHERE NEW.current_version < 1 OR NEW.current_revision_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM pipeline_automation_rule_revisions r
          WHERE r.tenant_id = NEW.tenant_id AND r.rule_id = NEW.rule_id
            AND r.revision_id = NEW.current_revision_id AND r.version = NEW.current_version
            AND r.pipeline_id = NEW.pipeline_id AND r.to_stage_id = NEW.to_stage_id
       );
END;

CREATE TRIGGER pipeline_automation_rule_revisions_lineage_guard
BEFORE INSERT ON pipeline_automation_rule_revisions
BEGIN
  SELECT RAISE(ABORT, 'pipeline_automation_rule_revision_head_missing')
    WHERE NOT EXISTS (
      SELECT 1 FROM pipeline_automation_rule_heads h
       WHERE h.tenant_id = NEW.tenant_id AND h.rule_id = NEW.rule_id
         AND h.pipeline_id = NEW.pipeline_id AND h.to_stage_id = NEW.to_stage_id
    );
  SELECT RAISE(ABORT, 'pipeline_automation_rule_revision_version_conflict')
    WHERE NOT EXISTS (
      SELECT 1 FROM pipeline_automation_rule_heads h
       WHERE h.tenant_id = NEW.tenant_id AND h.rule_id = NEW.rule_id
         AND NEW.version = h.current_version + 1
         AND NEW.prior_revision_id IS h.current_revision_id
    );
END;

CREATE TRIGGER pipeline_automation_rule_revisions_append_only_update
BEFORE UPDATE ON pipeline_automation_rule_revisions
BEGIN SELECT RAISE(ABORT, 'pipeline_automation_rule_revisions_append_only'); END;
CREATE TRIGGER pipeline_automation_rule_revisions_append_only_delete
BEFORE DELETE ON pipeline_automation_rule_revisions
BEGIN SELECT RAISE(ABORT, 'pipeline_automation_rule_revisions_append_only'); END;
CREATE TRIGGER pipeline_automation_rule_revisions_no_insert_replace
BEFORE INSERT ON pipeline_automation_rule_revisions
BEGIN
  SELECT RAISE(ABORT, 'pipeline_automation_rule_revisions_append_only')
    WHERE EXISTS (
      SELECT 1 FROM pipeline_automation_rule_revisions r
       WHERE r.revision_id = NEW.revision_id
          OR (r.tenant_id = NEW.tenant_id AND r.rule_id = NEW.rule_id AND r.version = NEW.version)
    );
END;

CREATE TRIGGER pipeline_stage_automation_invocations_identity_guard
BEFORE UPDATE ON pipeline_stage_automation_invocations
BEGIN
  SELECT RAISE(ABORT, 'pipeline_stage_automation_invocation_binding_immutable')
    WHERE NEW.invocation_id != OLD.invocation_id OR NEW.tenant_id != OLD.tenant_id
       OR NEW.outbox_id != OLD.outbox_id OR NEW.pipeline_id != OLD.pipeline_id
       OR NEW.transition_id != OLD.transition_id OR NEW.rule_id != OLD.rule_id
       OR NEW.rule_revision_id != OLD.rule_revision_id OR NEW.rule_version != OLD.rule_version
       OR NEW.action != OLD.action OR NEW.recipient_ref != OLD.recipient_ref
       OR NEW.template_key != OLD.template_key OR NEW.template_version != OLD.template_version
       OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'pipeline_stage_automation_invocation_terminal')
    WHERE OLD.status IN ('succeeded', 'failed', 'unknown') AND NEW.status != OLD.status;
  SELECT RAISE(ABORT, 'pipeline_stage_automation_invocation_invalid_transition')
    WHERE NOT (
      (OLD.status = 'pending' AND NEW.status = 'pending') OR
      (OLD.status = 'pending' AND NEW.status IN ('claimed', 'failed')) OR
      (OLD.status = 'retry' AND NEW.status = 'retry') OR
      (OLD.status = 'retry' AND NEW.status IN ('claimed', 'failed')) OR
      (OLD.status = 'claimed' AND NEW.status = 'claimed') OR
      (OLD.status = 'claimed' AND NEW.status IN ('retry', 'succeeded', 'failed', 'unknown')) OR
      (OLD.status IN ('succeeded', 'failed', 'unknown') AND NEW.status = OLD.status)
    );
  SELECT RAISE(ABORT, 'pipeline_stage_automation_invocation_evidence_immutable')
    WHERE (OLD.recipient_digest IS NOT NULL AND NEW.recipient_digest IS NOT OLD.recipient_digest)
       OR (OLD.effect_id IS NOT NULL AND NEW.effect_id IS NOT OLD.effect_id)
       OR (OLD.provider_external_id IS NOT NULL AND NEW.provider_external_id IS NOT OLD.provider_external_id)
       OR (OLD.provider_response_hash IS NOT NULL AND NEW.provider_response_hash IS NOT OLD.provider_response_hash)
       OR (OLD.readback_hash IS NOT NULL AND NEW.readback_hash IS NOT OLD.readback_hash)
       OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at);
END;

CREATE TRIGGER pipeline_stage_automation_invocations_append_only_delete
BEFORE DELETE ON pipeline_stage_automation_invocations
BEGIN SELECT RAISE(ABORT, 'pipeline_stage_automation_invocations_append_only'); END;
