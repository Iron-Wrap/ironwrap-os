-- 0124_schema_field_history.sql - governed schema fields and immutable value history (IRO-242).
--
-- Definitions and values are separate append-only aggregates.  The head rows are only the
-- server-maintained current pointers; revisions retain the complete attributable history.

CREATE TABLE IF NOT EXISTS schema_field_definition_heads (
  field_id TEXT PRIMARY KEY CHECK (
    length(field_id) BETWEEN 12 AND 200
    AND field_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  entity_type TEXT NOT NULL CHECK (
    length(trim(entity_type)) BETWEEN 1 AND 80
    AND entity_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  field_key TEXT NOT NULL CHECK (
    length(trim(field_key)) BETWEEN 1 AND 120
    AND field_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  current_revision_id TEXT,
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version BETWEEN 0 AND 1000000),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (field_id, tenant_id),
  UNIQUE (tenant_id, entity_type, field_key),
  FOREIGN KEY (current_revision_id, tenant_id)
    REFERENCES schema_field_definition_revisions(revision_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_schema_field_definition_heads_entity
  ON schema_field_definition_heads (tenant_id, entity_type, field_key);

CREATE TABLE IF NOT EXISTS schema_field_definition_revisions (
  revision_id TEXT PRIMARY KEY CHECK (
    length(revision_id) BETWEEN 12 AND 220
    AND revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  field_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  prior_revision_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('create', 'revise', 'relabel', 'reorder', 'retire')),
  entity_type TEXT NOT NULL CHECK (
    length(trim(entity_type)) BETWEEN 1 AND 80
    AND entity_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  field_key TEXT NOT NULL CHECK (
    length(trim(field_key)) BETWEEN 1 AND 120
    AND field_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 160),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 1000000),
  field_type TEXT NOT NULL CHECK (field_type IN (
    'text', 'integer', 'number', 'boolean', 'date', 'datetime', 'select',
    'multiselect', 'image', 'attachment', 'money', 'provider_fact'
  )),
  validator_key TEXT NOT NULL CHECK (validator_key IN (
    'none', 'required', 'email', 'phone', 'nonnegative', 'options', 'range',
    'date', 'datetime', 'provider_receipt'
  )),
  validator_config_json TEXT NOT NULL CHECK (
    length(validator_config_json) BETWEEN 2 AND 4096 AND json_valid(validator_config_json)
  ),
  visibility_key TEXT NOT NULL CHECK (
    visibility_key IN ('always', 'when_field_present', 'when_field_equals')
  ),
  visibility_config_json TEXT NOT NULL CHECK (
    length(visibility_config_json) BETWEEN 2 AND 4096 AND json_valid(visibility_config_json)
  ),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN (
    'none', 'source', 'derived', 'physical', 'authority', 'financial', 'decision', 'negative'
  )),
  retention_policy TEXT NOT NULL CHECK (retention_policy IN ('standard', 'extended', 'legal_hold')),
  offline_mode TEXT NOT NULL CHECK (offline_mode IN ('online_only', 'queueable', 'offline_read')),
  read_scope TEXT NOT NULL CHECK (read_scope IN ('all', 'assigned')),
  write_scope TEXT NOT NULL CHECK (write_scope IN ('all', 'assigned')),
  read_roles_json TEXT NOT NULL CHECK (
    length(read_roles_json) BETWEEN 3 AND 4096
    AND json_valid(read_roles_json)
    AND json_type(read_roles_json) = 'array'
    AND json_array_length(read_roles_json) BETWEEN 1 AND 6
  ),
  write_roles_json TEXT NOT NULL CHECK (
    length(write_roles_json) BETWEEN 3 AND 4096
    AND json_valid(write_roles_json)
    AND json_type(write_roles_json) = 'array'
    AND json_array_length(write_roles_json) BETWEEN 1 AND 6
  ),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'agent', 'worker')),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'ops', 'sales', 'production', 'accounting', 'field')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 160),
  authority_ref TEXT NOT NULL CHECK (length(trim(authority_ref)) BETWEEN 1 AND 280),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  effective_at TEXT NOT NULL CHECK (length(effective_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (revision_id, tenant_id),
  UNIQUE (tenant_id, field_id, version),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (field_id, tenant_id)
    REFERENCES schema_field_definition_heads(field_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_revision_id, tenant_id)
    REFERENCES schema_field_definition_revisions(revision_id, tenant_id) ON DELETE RESTRICT,
  CHECK (action = 'create' OR prior_revision_id IS NOT NULL),
  CHECK ((action = 'retire' AND active = 0) OR (action != 'retire' AND active = 1))
);

CREATE INDEX IF NOT EXISTS idx_schema_field_definition_revisions_current
  ON schema_field_definition_revisions (tenant_id, entity_type, field_key, version DESC);

CREATE TABLE IF NOT EXISTS schema_field_value_heads (
  value_head_id TEXT PRIMARY KEY CHECK (
    length(value_head_id) BETWEEN 16 AND 220
    AND value_head_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  entity_type TEXT NOT NULL CHECK (
    length(trim(entity_type)) BETWEEN 1 AND 80
    AND entity_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 200),
  field_id TEXT NOT NULL,
  current_revision_id TEXT,
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version BETWEEN 0 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (value_head_id, tenant_id),
  UNIQUE (tenant_id, entity_type, entity_id, field_id),
  FOREIGN KEY (field_id, tenant_id)
    REFERENCES schema_field_definition_heads(field_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_revision_id, tenant_id, entity_type, entity_id, field_id)
    REFERENCES schema_field_value_revisions(value_revision_id, tenant_id, entity_type, entity_id, field_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_schema_field_value_heads_entity
  ON schema_field_value_heads (tenant_id, entity_type, entity_id, field_id);

CREATE TABLE IF NOT EXISTS schema_field_value_revisions (
  value_revision_id TEXT PRIMARY KEY CHECK (
    length(value_revision_id) BETWEEN 16 AND 220
    AND value_revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  value_head_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (
    length(trim(entity_type)) BETWEEN 1 AND 80
    AND entity_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 200),
  field_id TEXT NOT NULL,
  field_definition_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  prior_value_revision_id TEXT,
  based_on_value_revision_id TEXT,
  correction_reason TEXT CHECK (
    correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 3 AND 1200
  ),
  value_json TEXT NOT NULL CHECK (
    length(value_json) BETWEEN 1 AND 32768 AND json_valid(value_json)
  ),
  value_digest TEXT NOT NULL CHECK (
    length(value_digest) = 64 AND value_digest NOT GLOB '*[^0-9a-f]*'
  ),
  provenance_actor_type TEXT NOT NULL CHECK (
    provenance_actor_type IN ('owner', 'agent', 'worker', 'device', 'external_authority')
  ),
  provenance_actor_id TEXT NOT NULL CHECK (length(trim(provenance_actor_id)) BETWEEN 1 AND 160),
  source_ref TEXT CHECK (source_ref IS NULL OR length(trim(source_ref)) BETWEEN 1 AND 280),
  evidence_ref TEXT CHECK (evidence_ref IS NULL OR length(trim(evidence_ref)) BETWEEN 1 AND 280),
  provider_receipt_id TEXT CHECK (
    provider_receipt_id IS NULL OR length(trim(provider_receipt_id)) BETWEEN 1 AND 220
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (value_revision_id, tenant_id, entity_type, entity_id, field_id),
  UNIQUE (tenant_id, entity_type, entity_id, field_id, version),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (value_head_id, tenant_id)
    REFERENCES schema_field_value_heads(value_head_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (field_definition_revision_id, tenant_id)
    REFERENCES schema_field_definition_revisions(revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_value_revision_id, tenant_id, entity_type, entity_id, field_id)
    REFERENCES schema_field_value_revisions(value_revision_id, tenant_id, entity_type, entity_id, field_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (based_on_value_revision_id, tenant_id, entity_type, entity_id, field_id)
    REFERENCES schema_field_value_revisions(value_revision_id, tenant_id, entity_type, entity_id, field_id)
    ON DELETE RESTRICT,
  CHECK (
    (version = 1 AND prior_value_revision_id IS NULL)
    OR (version > 1 AND prior_value_revision_id IS NOT NULL)
  ),
  CHECK (
    (based_on_value_revision_id IS NULL AND correction_reason IS NULL)
    OR (based_on_value_revision_id IS NOT NULL AND correction_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_schema_field_value_revisions_entity
  ON schema_field_value_revisions (tenant_id, entity_type, entity_id, field_id, version DESC);

CREATE TRIGGER IF NOT EXISTS schema_field_definition_head_guard
BEFORE UPDATE ON schema_field_definition_heads
BEGIN
  SELECT RAISE(ABORT, 'schema_field_definition_head_identity_immutable')
    WHERE NEW.field_id != OLD.field_id OR NEW.tenant_id != OLD.tenant_id
       OR NEW.entity_type != OLD.entity_type OR NEW.field_key != OLD.field_key
       OR NEW.created_by != OLD.created_by OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'schema_field_definition_head_version_conflict')
    WHERE NEW.current_version != OLD.current_version + 1;
  SELECT RAISE(ABORT, 'schema_field_definition_head_pointer_invalid')
    WHERE NEW.current_version < 1 OR NEW.current_revision_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM schema_field_definition_revisions revision
          WHERE revision.tenant_id = NEW.tenant_id
            AND revision.field_id = NEW.field_id
            AND revision.revision_id = NEW.current_revision_id
            AND revision.version = NEW.current_version
       );
END;

CREATE TRIGGER IF NOT EXISTS schema_field_definition_revision_insert_guard
BEFORE INSERT ON schema_field_definition_revisions
BEGIN
  SELECT RAISE(ABORT, 'schema_field_definition_revision_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM schema_field_definition_revisions revision
       WHERE revision.revision_id = NEW.revision_id
          OR (revision.tenant_id = NEW.tenant_id AND revision.field_id = NEW.field_id
              AND revision.version = NEW.version)
          OR (revision.tenant_id = NEW.tenant_id
              AND revision.idempotency_key_hash = NEW.idempotency_key_hash)
    );
  SELECT RAISE(ABORT, 'schema_field_definition_revision_head_missing')
    WHERE NOT EXISTS (
      SELECT 1 FROM schema_field_definition_heads head
       WHERE head.tenant_id = NEW.tenant_id AND head.field_id = NEW.field_id
         AND head.entity_type = NEW.entity_type AND head.field_key = NEW.field_key
    );
  SELECT RAISE(ABORT, 'schema_field_definition_revision_version_conflict')
    WHERE NOT EXISTS (
      SELECT 1 FROM schema_field_definition_heads head
       WHERE head.tenant_id = NEW.tenant_id AND head.field_id = NEW.field_id
         AND NEW.version = head.current_version + 1
         AND NEW.prior_revision_id IS head.current_revision_id
    );
  SELECT RAISE(ABORT, 'schema_field_definition_retention_weakened')
    WHERE EXISTS (
        SELECT 1 FROM schema_field_definition_revisions prior
         WHERE prior.tenant_id = NEW.tenant_id
           AND prior.revision_id = NEW.prior_revision_id
           AND (
             (prior.retention_policy = 'legal_hold' AND NEW.retention_policy != 'legal_hold')
             OR (prior.retention_policy = 'extended' AND NEW.retention_policy = 'standard')
           )
      );
  SELECT RAISE(ABORT, 'schema_field_definition_roles_invalid')
    WHERE EXISTS (
        SELECT 1 FROM json_each(NEW.read_roles_json)
         WHERE value NOT IN ('owner', 'ops', 'sales', 'production', 'accounting', 'field')
      )
       OR EXISTS (
        SELECT 1 FROM json_each(NEW.write_roles_json)
         WHERE value NOT IN ('owner', 'ops', 'sales', 'production', 'accounting', 'field')
      );
  SELECT RAISE(ABORT, 'schema_field_definition_action_invalid')
    WHERE NEW.action != 'create'
      AND EXISTS (
        SELECT 1 FROM schema_field_definition_revisions prior
         WHERE prior.tenant_id = NEW.tenant_id
           AND prior.revision_id = NEW.prior_revision_id
           AND prior.field_type != NEW.field_type
      );
  SELECT RAISE(ABORT, 'schema_field_definition_action_invalid')
    WHERE NEW.action = 'relabel'
      AND NOT EXISTS (
        SELECT 1 FROM schema_field_definition_revisions prior
         WHERE prior.tenant_id = NEW.tenant_id
           AND prior.revision_id = NEW.prior_revision_id
           AND NEW.label != prior.label
           AND NEW.position = prior.position
           AND NEW.field_type = prior.field_type
           AND NEW.validator_key = prior.validator_key
           AND NEW.validator_config_json = prior.validator_config_json
           AND NEW.visibility_key = prior.visibility_key
           AND NEW.visibility_config_json = prior.visibility_config_json
           AND NEW.evidence_class = prior.evidence_class
           AND NEW.retention_policy = prior.retention_policy
           AND NEW.offline_mode = prior.offline_mode
           AND NEW.read_scope = prior.read_scope
           AND NEW.write_scope = prior.write_scope
           AND NEW.read_roles_json = prior.read_roles_json
           AND NEW.write_roles_json = prior.write_roles_json
           AND NEW.active = prior.active
      );
  SELECT RAISE(ABORT, 'schema_field_definition_action_invalid')
    WHERE NEW.action = 'reorder'
      AND NOT EXISTS (
        SELECT 1 FROM schema_field_definition_revisions prior
         WHERE prior.tenant_id = NEW.tenant_id
           AND prior.revision_id = NEW.prior_revision_id
           AND NEW.position != prior.position
           AND NEW.label = prior.label
           AND NEW.field_type = prior.field_type
           AND NEW.validator_key = prior.validator_key
           AND NEW.validator_config_json = prior.validator_config_json
           AND NEW.visibility_key = prior.visibility_key
           AND NEW.visibility_config_json = prior.visibility_config_json
           AND NEW.evidence_class = prior.evidence_class
           AND NEW.retention_policy = prior.retention_policy
           AND NEW.offline_mode = prior.offline_mode
           AND NEW.read_scope = prior.read_scope
           AND NEW.write_scope = prior.write_scope
           AND NEW.read_roles_json = prior.read_roles_json
           AND NEW.write_roles_json = prior.write_roles_json
           AND NEW.active = prior.active
      );
  SELECT RAISE(ABORT, 'schema_field_definition_action_invalid')
    WHERE NEW.action = 'retire'
      AND NOT EXISTS (
        SELECT 1 FROM schema_field_definition_revisions prior
         WHERE prior.tenant_id = NEW.tenant_id
           AND prior.revision_id = NEW.prior_revision_id
           AND NEW.active = 0
           AND NEW.label = prior.label
           AND NEW.position = prior.position
           AND NEW.field_type = prior.field_type
           AND NEW.validator_key = prior.validator_key
           AND NEW.validator_config_json = prior.validator_config_json
           AND NEW.visibility_key = prior.visibility_key
           AND NEW.visibility_config_json = prior.visibility_config_json
           AND NEW.evidence_class = prior.evidence_class
           AND NEW.retention_policy = prior.retention_policy
           AND NEW.offline_mode = prior.offline_mode
           AND NEW.read_scope = prior.read_scope
           AND NEW.write_scope = prior.write_scope
           AND NEW.read_roles_json = prior.read_roles_json
           AND NEW.write_roles_json = prior.write_roles_json
      );
END;

CREATE TRIGGER IF NOT EXISTS schema_field_definition_revision_head_projection
AFTER INSERT ON schema_field_definition_revisions
BEGIN
  UPDATE schema_field_definition_heads
     SET current_revision_id = NEW.revision_id,
         current_version = NEW.version,
         updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id AND field_id = NEW.field_id
     AND current_version = NEW.version - 1
     AND current_revision_id IS NEW.prior_revision_id;
  SELECT RAISE(ABORT, 'schema_field_definition_head_update_conflict') WHERE changes() != 1;
END;

CREATE TRIGGER IF NOT EXISTS schema_field_definition_revision_append_only_update
BEFORE UPDATE ON schema_field_definition_revisions
BEGIN SELECT RAISE(ABORT, 'schema_field_definition_revisions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS schema_field_definition_revision_append_only_delete
BEFORE DELETE ON schema_field_definition_revisions
BEGIN SELECT RAISE(ABORT, 'schema_field_definition_revisions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS schema_field_value_head_guard
BEFORE UPDATE ON schema_field_value_heads
BEGIN
  SELECT RAISE(ABORT, 'schema_field_value_head_identity_immutable')
    WHERE NEW.value_head_id != OLD.value_head_id OR NEW.tenant_id != OLD.tenant_id
       OR NEW.entity_type != OLD.entity_type OR NEW.entity_id != OLD.entity_id
       OR NEW.field_id != OLD.field_id OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'schema_field_value_head_version_conflict')
    WHERE NEW.current_version != OLD.current_version + 1;
  SELECT RAISE(ABORT, 'schema_field_value_head_pointer_invalid')
    WHERE NEW.current_version < 1 OR NEW.current_revision_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM schema_field_value_revisions revision
          WHERE revision.tenant_id = NEW.tenant_id
            AND revision.value_revision_id = NEW.current_revision_id
            AND revision.entity_type = NEW.entity_type
            AND revision.entity_id = NEW.entity_id
            AND revision.field_id = NEW.field_id
            AND revision.version = NEW.current_version
       );
END;

CREATE TRIGGER IF NOT EXISTS schema_field_value_revision_insert_guard
BEFORE INSERT ON schema_field_value_revisions
BEGIN
  SELECT RAISE(ABORT, 'schema_field_value_revision_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM schema_field_value_revisions revision
       WHERE revision.value_revision_id = NEW.value_revision_id
          OR (revision.tenant_id = NEW.tenant_id AND revision.entity_type = NEW.entity_type
              AND revision.entity_id = NEW.entity_id AND revision.field_id = NEW.field_id
              AND revision.version = NEW.version)
          OR (revision.tenant_id = NEW.tenant_id
              AND revision.idempotency_key_hash = NEW.idempotency_key_hash)
    );
  SELECT RAISE(ABORT, 'schema_field_value_revision_head_missing')
    WHERE NOT EXISTS (
      SELECT 1 FROM schema_field_value_heads head
       WHERE head.tenant_id = NEW.tenant_id AND head.value_head_id = NEW.value_head_id
         AND head.entity_type = NEW.entity_type AND head.entity_id = NEW.entity_id
         AND head.field_id = NEW.field_id
    );
  SELECT RAISE(ABORT, 'schema_field_value_definition_revision_invalid')
    WHERE NOT EXISTS (
      SELECT 1
        FROM schema_field_definition_heads field_head
        JOIN schema_field_definition_revisions definition_revision
          ON definition_revision.tenant_id = field_head.tenant_id
         AND definition_revision.field_id = field_head.field_id
         AND definition_revision.revision_id = field_head.current_revision_id
         AND definition_revision.version = field_head.current_version
       WHERE field_head.tenant_id = NEW.tenant_id
         AND field_head.field_id = NEW.field_id
         AND field_head.entity_type = NEW.entity_type
         AND definition_revision.revision_id = NEW.field_definition_revision_id
    );
  SELECT RAISE(ABORT, 'schema_field_value_revision_version_conflict')
    WHERE NOT EXISTS (
      SELECT 1 FROM schema_field_value_heads head
       WHERE head.tenant_id = NEW.tenant_id AND head.value_head_id = NEW.value_head_id
         AND NEW.version = head.current_version + 1
         AND NEW.prior_value_revision_id IS head.current_revision_id
    );
END;

CREATE TRIGGER IF NOT EXISTS schema_field_value_revision_head_projection
AFTER INSERT ON schema_field_value_revisions
BEGIN
  UPDATE schema_field_value_heads
     SET current_revision_id = NEW.value_revision_id,
         current_version = NEW.version,
         updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id AND value_head_id = NEW.value_head_id
     AND current_version = NEW.version - 1
     AND current_revision_id IS NEW.prior_value_revision_id;
  SELECT RAISE(ABORT, 'schema_field_value_head_update_conflict') WHERE changes() != 1;
END;

CREATE TRIGGER IF NOT EXISTS schema_field_value_revision_append_only_update
BEFORE UPDATE ON schema_field_value_revisions
BEGIN SELECT RAISE(ABORT, 'schema_field_value_revisions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS schema_field_value_revision_append_only_delete
BEFORE DELETE ON schema_field_value_revisions
BEGIN SELECT RAISE(ABORT, 'schema_field_value_revisions_append_only'); END;

-- Evidence is a small generic receipt aggregate shared by immutable object values and
-- provider facts.  It is deliberately not a mutable URL/object catalog: every value must
-- point at one exact, attributable receipt whose scope, digest and capture facts cannot be
-- rewritten after insertion.
CREATE TABLE IF NOT EXISTS schema_field_evidence_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) BETWEEN 12 AND 220
    AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  entity_type TEXT NOT NULL CHECK (
    length(trim(entity_type)) BETWEEN 1 AND 80
    AND entity_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 200),
  field_id TEXT NOT NULL,
  field_definition_revision_id TEXT NOT NULL,
  value_version INTEGER NOT NULL CHECK (value_version BETWEEN 1 AND 1000000),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('object', 'provider_fact')),
  object_ref TEXT CHECK (
    object_ref IS NULL OR (
      length(object_ref) BETWEEN 3 AND 280
      AND object_ref NOT GLOB '*[^A-Za-z0-9._:/-]*'
      AND object_ref NOT LIKE 'http://%'
      AND object_ref NOT LIKE 'https://%'
    )
  ),
  object_digest TEXT CHECK (
    object_digest IS NULL OR (length(object_digest) = 64 AND object_digest NOT GLOB '*[^0-9a-f]*')
  ),
  provider_receipt_id TEXT,
  provider TEXT,
  provider_external_id TEXT,
  provider_action TEXT,
  provider_aggregate_type TEXT,
  provider_aggregate_id TEXT,
  provider_aggregate_version INTEGER CHECK (provider_aggregate_version IS NULL OR provider_aggregate_version >= 1),
  expected_readback_schema TEXT,
  expected_value_digest TEXT CHECK (
    expected_value_digest IS NULL OR (length(expected_value_digest) = 64 AND expected_value_digest NOT GLOB '*[^0-9a-f]*')
  ),
  provider_version TEXT,
  readback_digest TEXT CHECK (
    readback_digest IS NULL OR (length(readback_digest) = 64 AND readback_digest NOT GLOB '*[^0-9a-f]*')
  ),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'agent', 'worker', 'device', 'external_authority')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 160),
  captured_at TEXT NOT NULL CHECK (length(captured_at) BETWEEN 20 AND 40),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN (
    'source', 'derived', 'physical', 'authority', 'financial', 'decision', 'negative'
  )),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (receipt_id, tenant_id),
  UNIQUE (tenant_id, provider_receipt_id),
  FOREIGN KEY (field_id, tenant_id)
    REFERENCES schema_field_definition_heads(field_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (field_definition_revision_id, tenant_id)
    REFERENCES schema_field_definition_revisions(revision_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (evidence_kind = 'object'
      AND object_ref IS NOT NULL AND object_digest IS NOT NULL
      AND provider_receipt_id IS NULL AND provider IS NULL AND provider_external_id IS NULL
      AND provider_action IS NULL AND provider_aggregate_type IS NULL AND provider_aggregate_id IS NULL
      AND provider_aggregate_version IS NULL AND expected_readback_schema IS NULL
      AND expected_value_digest IS NULL AND provider_version IS NULL AND readback_digest IS NULL)
    OR
    (evidence_kind = 'provider_fact'
      AND object_ref IS NULL AND object_digest IS NULL
      AND provider_receipt_id IS NOT NULL AND provider IS NOT NULL AND provider_external_id IS NOT NULL
      AND provider_action = 'schema_field.provider_fact.read'
      AND provider_aggregate_type = 'schema_field_value' AND provider_aggregate_id IS NOT NULL
      AND provider_aggregate_version IS NOT NULL AND expected_readback_schema = 'ironwrap.schema-field-provider-fact.v1'
      AND expected_value_digest IS NOT NULL AND provider_version IS NOT NULL AND readback_digest IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_schema_field_evidence_receipts_scope
  ON schema_field_evidence_receipts (tenant_id, entity_type, entity_id, field_id, value_version);

CREATE INDEX IF NOT EXISTS idx_schema_field_evidence_receipts_provider
  ON schema_field_evidence_receipts (tenant_id, provider_receipt_id);

CREATE TRIGGER IF NOT EXISTS schema_field_evidence_receipts_insert_guard
BEFORE INSERT ON schema_field_evidence_receipts
BEGIN
  SELECT RAISE(ABORT, 'schema_field_evidence_receipt_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM schema_field_evidence_receipts receipt
       WHERE receipt.receipt_id = NEW.receipt_id
          OR (NEW.provider_receipt_id IS NOT NULL
              AND receipt.tenant_id = NEW.tenant_id
              AND receipt.provider_receipt_id = NEW.provider_receipt_id)
    );
  SELECT RAISE(ABORT, 'schema_field_evidence_receipt_scope_invalid')
    WHERE NOT EXISTS (
      SELECT 1
        FROM schema_field_definition_heads field_head
        JOIN schema_field_definition_revisions definition_revision
          ON definition_revision.tenant_id = field_head.tenant_id
         AND definition_revision.field_id = field_head.field_id
         AND definition_revision.revision_id = field_head.current_revision_id
         AND definition_revision.version = field_head.current_version
       WHERE field_head.tenant_id = NEW.tenant_id
         AND field_head.field_id = NEW.field_id
         AND field_head.entity_type = NEW.entity_type
         AND definition_revision.revision_id = NEW.field_definition_revision_id
    );
  SELECT RAISE(ABORT, 'schema_field_provider_receipt_invalid')
    WHERE NEW.evidence_kind = 'provider_fact'
      AND NOT EXISTS (
        SELECT 1 FROM external_effects effect
         WHERE effect.tenant_id = NEW.tenant_id
           AND effect.effect_id = NEW.provider_receipt_id
           AND effect.state = 'succeeded'
           AND effect.provider = NEW.provider
           AND effect.provider_external_id = NEW.provider_external_id
           AND effect.action = NEW.provider_action
           AND effect.aggregate_type = NEW.provider_aggregate_type
           AND effect.aggregate_id = NEW.provider_aggregate_id
           AND effect.aggregate_version = NEW.provider_aggregate_version
           AND effect.intent_id = NEW.receipt_id
           AND effect.readback_hash = NEW.readback_digest
           AND json_valid(effect.expected_readback_json)
           AND json_extract(effect.expected_readback_json, '$.schema_version') = NEW.expected_readback_schema
           AND json_extract(effect.expected_readback_json, '$.tenant_id') = NEW.tenant_id
           AND json_extract(effect.expected_readback_json, '$.entity_type') = NEW.entity_type
           AND json_extract(effect.expected_readback_json, '$.entity_id') = NEW.entity_id
           AND json_extract(effect.expected_readback_json, '$.field_id') = NEW.field_id
           AND json_extract(effect.expected_readback_json, '$.field_definition_revision_id') = NEW.field_definition_revision_id
           AND json_extract(effect.expected_readback_json, '$.value_version') = NEW.value_version
           AND json_extract(effect.expected_readback_json, '$.value_digest') = NEW.expected_value_digest
           AND json_extract(effect.expected_readback_json, '$.provider') = NEW.provider
           AND json_extract(effect.expected_readback_json, '$.provider_version') = NEW.provider_version
           AND json_extract(effect.expected_readback_json, '$.provider_external_id') = NEW.provider_external_id
           AND json_extract(effect.expected_readback_json, '$.readback_digest') = NEW.readback_digest
      );
END;

CREATE TRIGGER IF NOT EXISTS schema_field_evidence_receipts_no_insert_replace
BEFORE INSERT ON schema_field_evidence_receipts
BEGIN
  SELECT RAISE(ABORT, 'schema_field_evidence_receipts_append_only')
    WHERE EXISTS (
      SELECT 1 FROM schema_field_evidence_receipts receipt
       WHERE receipt.receipt_id = NEW.receipt_id
          OR (NEW.provider_receipt_id IS NOT NULL
              AND receipt.tenant_id = NEW.tenant_id
              AND receipt.provider_receipt_id = NEW.provider_receipt_id)
    );
END;

CREATE TRIGGER IF NOT EXISTS schema_field_evidence_receipts_append_only_update
BEFORE UPDATE ON schema_field_evidence_receipts
BEGIN SELECT RAISE(ABORT, 'schema_field_evidence_receipts_append_only'); END;

CREATE TRIGGER IF NOT EXISTS schema_field_evidence_receipts_append_only_delete
BEFORE DELETE ON schema_field_evidence_receipts
BEGIN SELECT RAISE(ABORT, 'schema_field_evidence_receipts_append_only'); END;
