-- 0125_document_templates_and_generation.sql - closed document templates and governed generation receipts (IRO-242).
--
-- A template revision is immutable configuration.  A generation attempt captures the exact
-- template/value snapshot before any provider work.  Terminal receipts append reconciliation
-- outcomes; neither an attempt nor a receipt is ever rewritten in place.

CREATE TABLE IF NOT EXISTS document_template_heads (
  template_id TEXT PRIMARY KEY CHECK (
    length(template_id) BETWEEN 12 AND 220
    AND template_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  entity_type TEXT NOT NULL CHECK (
    length(trim(entity_type)) BETWEEN 1 AND 80
    AND entity_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  template_key TEXT NOT NULL CHECK (
    length(trim(template_key)) BETWEEN 1 AND 120
    AND template_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  current_revision_id TEXT,
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version BETWEEN 0 AND 1000000),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (template_id, tenant_id),
  UNIQUE (tenant_id, entity_type, template_key),
  FOREIGN KEY (current_revision_id, tenant_id)
    REFERENCES document_template_revisions(revision_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_document_template_heads_entity
  ON document_template_heads (tenant_id, entity_type, template_key);

CREATE TABLE IF NOT EXISTS document_template_revisions (
  revision_id TEXT PRIMARY KEY CHECK (
    length(revision_id) BETWEEN 16 AND 240
    AND revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  prior_revision_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('create', 'revise', 'retire')),
  entity_type TEXT NOT NULL CHECK (
    length(trim(entity_type)) BETWEEN 1 AND 80
    AND entity_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  template_key TEXT NOT NULL CHECK (
    length(trim(template_key)) BETWEEN 1 AND 120
    AND template_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 160),
  blocks_json TEXT NOT NULL CHECK (
    length(blocks_json) BETWEEN 2 AND 32768
    AND json_valid(blocks_json)
    AND json_type(blocks_json) = 'array'
    AND json_array_length(blocks_json) BETWEEN 1 AND 200
  ),
  retention_policy TEXT NOT NULL CHECK (retention_policy IN ('standard', 'extended', 'legal_hold')),
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
  UNIQUE (tenant_id, template_id, version),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (template_id, tenant_id)
    REFERENCES document_template_heads(template_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_revision_id, tenant_id)
    REFERENCES document_template_revisions(revision_id, tenant_id) ON DELETE RESTRICT,
  CHECK ((action = 'create' AND prior_revision_id IS NULL) OR (action != 'create' AND prior_revision_id IS NOT NULL)),
  CHECK ((action = 'retire' AND active = 0) OR (action != 'retire' AND active = 1))
);

CREATE INDEX IF NOT EXISTS idx_document_template_revisions_current
  ON document_template_revisions (tenant_id, entity_type, template_key, version DESC);

CREATE TRIGGER IF NOT EXISTS document_template_head_guard
BEFORE UPDATE ON document_template_heads
BEGIN
  SELECT RAISE(ABORT, 'document_template_head_identity_immutable')
    WHERE NEW.template_id != OLD.template_id OR NEW.tenant_id != OLD.tenant_id
       OR NEW.entity_type != OLD.entity_type OR NEW.template_key != OLD.template_key
       OR NEW.created_by != OLD.created_by OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'document_template_head_version_conflict')
    WHERE NEW.current_version != OLD.current_version + 1;
  SELECT RAISE(ABORT, 'document_template_head_pointer_invalid')
    WHERE NEW.current_version < 1 OR NEW.current_revision_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM document_template_revisions revision
          WHERE revision.tenant_id = NEW.tenant_id
            AND revision.template_id = NEW.template_id
            AND revision.revision_id = NEW.current_revision_id
            AND revision.version = NEW.current_version
       );
END;

CREATE TRIGGER IF NOT EXISTS document_template_revision_insert_guard
BEFORE INSERT ON document_template_revisions
BEGIN
  SELECT RAISE(ABORT, 'document_template_revision_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM document_template_revisions revision
       WHERE revision.revision_id = NEW.revision_id
          OR (revision.tenant_id = NEW.tenant_id AND revision.template_id = NEW.template_id
              AND revision.version = NEW.version)
          OR (revision.tenant_id = NEW.tenant_id
              AND revision.idempotency_key_hash = NEW.idempotency_key_hash)
    );
  SELECT RAISE(ABORT, 'document_template_revision_head_missing')
    WHERE NOT EXISTS (
      SELECT 1 FROM document_template_heads head
       WHERE head.tenant_id = NEW.tenant_id AND head.template_id = NEW.template_id
         AND head.entity_type = NEW.entity_type AND head.template_key = NEW.template_key
    );
  SELECT RAISE(ABORT, 'document_template_revision_version_conflict')
    WHERE NOT EXISTS (
      SELECT 1 FROM document_template_heads head
       WHERE head.tenant_id = NEW.tenant_id AND head.template_id = NEW.template_id
         AND NEW.version = head.current_version + 1
         AND NEW.prior_revision_id IS head.current_revision_id
    );
  SELECT RAISE(ABORT, 'document_template_retention_weakened')
    WHERE EXISTS (
      SELECT 1 FROM document_template_revisions prior
       WHERE prior.tenant_id = NEW.tenant_id
         AND prior.revision_id = NEW.prior_revision_id
         AND (
           (prior.retention_policy = 'legal_hold' AND NEW.retention_policy != 'legal_hold')
           OR (prior.retention_policy = 'extended' AND NEW.retention_policy = 'standard')
         )
    );
  SELECT RAISE(ABORT, 'document_template_block_invalid')
    WHERE EXISTS (
      SELECT 1 FROM json_each(NEW.blocks_json) block
       WHERE json_type(block.value) IS NOT 'object'
          OR json_extract(block.value, '$.kind') IS NULL
          OR json_extract(block.value, '$.kind') NOT IN ('text', 'heading', 'field')
          OR (json_extract(block.value, '$.kind') = 'text' AND (
            json_type(block.value, '$.text') IS NOT 'text'
            OR length(trim(json_extract(block.value, '$.text'))) NOT BETWEEN 1 AND 4000
            OR instr(json_extract(block.value, '$.text'), '<') > 0
            OR instr(json_extract(block.value, '$.text'), '>') > 0
            OR EXISTS (
              SELECT 1 FROM json_each(block.value) key
               WHERE key.key NOT IN ('kind', 'text')
            )
          ))
          OR (json_extract(block.value, '$.kind') = 'heading' AND (
            json_type(block.value, '$.level') IS NOT 'integer'
            OR json_extract(block.value, '$.level') NOT IN (1, 2, 3)
            OR json_type(block.value, '$.text') IS NOT 'text'
            OR length(trim(json_extract(block.value, '$.text'))) NOT BETWEEN 1 AND 4000
            OR instr(json_extract(block.value, '$.text'), '<') > 0
            OR instr(json_extract(block.value, '$.text'), '>') > 0
            OR EXISTS (
              SELECT 1 FROM json_each(block.value) key
               WHERE key.key NOT IN ('kind', 'level', 'text')
            )
          ))
          OR (json_extract(block.value, '$.kind') = 'field' AND (
            json_type(block.value, '$.field_id') IS NOT 'text'
            OR length(trim(json_extract(block.value, '$.field_id'))) NOT BETWEEN 12 AND 200
            OR json_extract(block.value, '$.field_id') GLOB '*[^A-Za-z0-9._:-]*'
            OR EXISTS (
              SELECT 1 FROM json_each(block.value) key
               WHERE key.key NOT IN ('kind', 'field_id')
            )
          ))
    );
  SELECT RAISE(ABORT, 'document_template_binding_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM json_each(NEW.blocks_json) first_block
       JOIN json_each(NEW.blocks_json) second_block
         ON first_block.key < second_block.key
        AND json_extract(first_block.value, '$.kind') = 'field'
        AND json_extract(second_block.value, '$.kind') = 'field'
        AND json_extract(first_block.value, '$.field_id') = json_extract(second_block.value, '$.field_id')
    );
  SELECT RAISE(ABORT, 'document_template_binding_invalid')
    WHERE EXISTS (
      SELECT 1 FROM json_each(NEW.blocks_json) block
       WHERE json_extract(block.value, '$.kind') = 'field'
         AND NOT EXISTS (
           SELECT 1 FROM schema_field_definition_heads field_head
            WHERE field_head.tenant_id = NEW.tenant_id
              AND field_head.entity_type = NEW.entity_type
              AND field_head.field_id = json_extract(block.value, '$.field_id')
              AND EXISTS (
                SELECT 1 FROM schema_field_definition_revisions definition
                 WHERE definition.tenant_id = field_head.tenant_id
                   AND definition.field_id = field_head.field_id
                   AND definition.revision_id = field_head.current_revision_id
                   AND definition.version = field_head.current_version
                   AND definition.active = 1
              )
         )
    );
END;

CREATE TRIGGER IF NOT EXISTS document_template_revision_head_projection
AFTER INSERT ON document_template_revisions
BEGIN
  UPDATE document_template_heads
     SET current_revision_id = NEW.revision_id,
         current_version = NEW.version,
         updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id AND template_id = NEW.template_id
     AND current_version = NEW.version - 1
     AND current_revision_id IS NEW.prior_revision_id;
  SELECT RAISE(ABORT, 'document_template_head_update_conflict') WHERE changes() != 1;
END;

CREATE TRIGGER IF NOT EXISTS document_template_revision_no_insert_replace
BEFORE INSERT ON document_template_revisions
BEGIN
  SELECT RAISE(ABORT, 'document_template_revisions_append_only')
    WHERE EXISTS (
      SELECT 1 FROM document_template_revisions revision
       WHERE revision.revision_id = NEW.revision_id
          OR (revision.tenant_id = NEW.tenant_id AND revision.template_id = NEW.template_id
              AND revision.version = NEW.version)
          OR (revision.tenant_id = NEW.tenant_id
              AND revision.idempotency_key_hash = NEW.idempotency_key_hash)
    );
END;

CREATE TRIGGER IF NOT EXISTS document_template_revisions_append_only_update
BEFORE UPDATE ON document_template_revisions
BEGIN SELECT RAISE(ABORT, 'document_template_revisions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS document_template_revisions_append_only_delete
BEFORE DELETE ON document_template_revisions
BEGIN SELECT RAISE(ABORT, 'document_template_revisions_append_only'); END;

CREATE TABLE IF NOT EXISTS document_generation_attempts (
  generation_attempt_id TEXT PRIMARY KEY CHECK (
    length(generation_attempt_id) BETWEEN 16 AND 220
    AND generation_attempt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
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
  template_id TEXT NOT NULL,
  template_revision_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version BETWEEN 1 AND 1000000),
  external_effect_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 120),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('actor', 'service')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'agent', 'worker')),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'ops', 'sales', 'production', 'accounting', 'field')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 160),
  authority_ref TEXT NOT NULL CHECK (length(trim(authority_ref)) BETWEEN 1 AND 280),
  policy_ref TEXT NOT NULL CHECK (length(trim(policy_ref)) BETWEEN 1 AND 280),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 80),
  permit_expires_at TEXT,
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  stop_policy TEXT NOT NULL CHECK (stop_policy IN ('stop_on_unknown', 'stop_on_conflict')),
  compensation_policy TEXT NOT NULL CHECK (compensation_policy IN ('none', 'manual_review')),
  input_count INTEGER NOT NULL CHECK (input_count BETWEEN 1 AND 200),
  input_snapshot_digest TEXT NOT NULL CHECK (
    length(input_snapshot_digest) = 64 AND input_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  output_digest TEXT NOT NULL CHECK (
    length(output_digest) = 64 AND output_digest NOT GLOB '*[^0-9a-f]*'
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (generation_attempt_id, tenant_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (template_revision_id, tenant_id)
    REFERENCES document_template_revisions(revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (external_effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_document_generation_attempts_scope
  ON document_generation_attempts (tenant_id, entity_type, entity_id, template_id, created_at);

CREATE TRIGGER IF NOT EXISTS document_generation_attempt_insert_guard
BEFORE INSERT ON document_generation_attempts
BEGIN
  SELECT RAISE(ABORT, 'document_generation_attempt_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM document_generation_attempts attempt
       WHERE attempt.generation_attempt_id = NEW.generation_attempt_id
          OR (attempt.tenant_id = NEW.tenant_id
              AND attempt.idempotency_key_hash = NEW.idempotency_key_hash)
    );
  SELECT RAISE(ABORT, 'document_generation_template_scope_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM document_template_revisions template
       WHERE template.tenant_id = NEW.tenant_id
         AND template.template_id = NEW.template_id
         AND template.revision_id = NEW.template_revision_id
         AND template.version = NEW.template_version
         AND template.entity_type = NEW.entity_type
         AND template.active = 1
    );
  SELECT RAISE(ABORT, 'document_generation_effect_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.provider = NEW.provider
         AND effect.intent_id = NEW.generation_attempt_id
         AND effect.action = 'document.generate'
         AND effect.aggregate_type = 'document_generation'
         AND effect.aggregate_id = NEW.generation_attempt_id
         AND effect.aggregate_version = NEW.template_version
         AND effect.actor_type = NEW.actor_type
         AND effect.actor_id = NEW.actor_id
         AND effect.authority_ref = NEW.authority_ref
         AND effect.policy_ref = NEW.policy_ref
         AND effect.policy_version = NEW.policy_version
    );
  SELECT RAISE(ABORT, 'document_generation_retry_budget_invalid')
    WHERE EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.provider = NEW.provider
         AND effect.intent_id = NEW.generation_attempt_id
         AND effect.action = 'document.generate'
         AND effect.aggregate_type = 'document_generation'
         AND effect.aggregate_id = NEW.generation_attempt_id
         AND effect.aggregate_version = NEW.template_version
         AND effect.retry_limit + 1 > NEW.max_attempts
    );
  SELECT RAISE(ABORT, 'document_generation_effect_readback_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND json_valid(effect.expected_readback_json)
         AND (SELECT COUNT(*) FROM json_each(effect.expected_readback_json)) = 12
         AND json_extract(effect.expected_readback_json, '$.schema_version') = 'ironwrap.document-generation-readback.v1'
         AND json_extract(effect.expected_readback_json, '$.tenant_id') = NEW.tenant_id
         AND json_extract(effect.expected_readback_json, '$.entity_type') = NEW.entity_type
         AND json_extract(effect.expected_readback_json, '$.entity_id') = NEW.entity_id
         AND json_extract(effect.expected_readback_json, '$.generation_attempt_id') = NEW.generation_attempt_id
         AND json_extract(effect.expected_readback_json, '$.template_id') = NEW.template_id
         AND json_extract(effect.expected_readback_json, '$.template_revision_id') = NEW.template_revision_id
         AND json_extract(effect.expected_readback_json, '$.template_version') = NEW.template_version
         AND json_extract(effect.expected_readback_json, '$.input_snapshot_digest') = NEW.input_snapshot_digest
         AND json_extract(effect.expected_readback_json, '$.provider') = NEW.provider
         AND json_extract(effect.expected_readback_json, '$.output_digest') = NEW.output_digest
    );
  SELECT RAISE(ABORT, 'document_generation_service_authority_invalid')
    WHERE (NEW.authority_kind = 'service' AND (
      NEW.permit_expires_at IS NULL OR length(NEW.permit_expires_at) < 20
      OR NEW.actor_type != 'worker' OR NEW.actor_role NOT IN ('owner', 'ops')
    )) OR (NEW.authority_kind = 'actor' AND NEW.permit_expires_at IS NOT NULL);
END;

CREATE TRIGGER IF NOT EXISTS document_generation_attempt_no_insert_replace
BEFORE INSERT ON document_generation_attempts
BEGIN
  SELECT RAISE(ABORT, 'document_generation_attempts_append_only')
    WHERE EXISTS (
      SELECT 1 FROM document_generation_attempts attempt
       WHERE attempt.generation_attempt_id = NEW.generation_attempt_id
          OR (attempt.tenant_id = NEW.tenant_id
              AND attempt.idempotency_key_hash = NEW.idempotency_key_hash)
    );
END;

CREATE TRIGGER IF NOT EXISTS document_generation_attempts_append_only_update
BEFORE UPDATE ON document_generation_attempts
BEGIN SELECT RAISE(ABORT, 'document_generation_attempts_append_only'); END;

CREATE TRIGGER IF NOT EXISTS document_generation_attempts_append_only_delete
BEFORE DELETE ON document_generation_attempts
BEGIN SELECT RAISE(ABORT, 'document_generation_attempts_append_only'); END;

CREATE TABLE IF NOT EXISTS document_generation_inputs (
  generation_attempt_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 199),
  entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) BETWEEN 1 AND 80),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 200),
  field_id TEXT NOT NULL,
  field_definition_revision_id TEXT NOT NULL,
  field_definition_version INTEGER NOT NULL CHECK (field_definition_version BETWEEN 1 AND 1000000),
  value_revision_id TEXT NOT NULL,
  value_version INTEGER NOT NULL CHECK (value_version BETWEEN 1 AND 1000000),
  value_digest TEXT NOT NULL CHECK (
    length(value_digest) = 64 AND value_digest NOT GLOB '*[^0-9a-f]*'
  ),
  value_json TEXT NOT NULL CHECK (length(value_json) BETWEEN 1 AND 32768 AND json_valid(value_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  PRIMARY KEY (generation_attempt_id, sequence),
  UNIQUE (generation_attempt_id, field_id),
  FOREIGN KEY (generation_attempt_id) REFERENCES document_generation_attempts(generation_attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (field_id, tenant_id) REFERENCES schema_field_definition_heads(field_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (field_definition_revision_id, tenant_id)
    REFERENCES schema_field_definition_revisions(revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (value_revision_id, tenant_id, entity_type, entity_id, field_id)
    REFERENCES schema_field_value_revisions(value_revision_id, tenant_id, entity_type, entity_id, field_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_document_generation_inputs_scope
  ON document_generation_inputs (tenant_id, entity_type, entity_id, generation_attempt_id, sequence);

CREATE TRIGGER IF NOT EXISTS document_generation_input_insert_guard
BEFORE INSERT ON document_generation_inputs
BEGIN
  SELECT RAISE(ABORT, 'document_generation_input_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM document_generation_inputs input
       WHERE input.generation_attempt_id = NEW.generation_attempt_id
          AND (input.sequence = NEW.sequence OR input.field_id = NEW.field_id)
    );
  SELECT RAISE(ABORT, 'document_generation_input_scope_invalid')
    WHERE NOT EXISTS (
      SELECT 1
        FROM document_generation_attempts attempt
        JOIN document_template_revisions template
          ON template.tenant_id = attempt.tenant_id
         AND template.template_id = attempt.template_id
         AND template.revision_id = attempt.template_revision_id
       WHERE attempt.generation_attempt_id = NEW.generation_attempt_id
         AND attempt.tenant_id = NEW.tenant_id
         AND attempt.entity_type = NEW.entity_type
         AND attempt.entity_id = NEW.entity_id
         AND EXISTS (
           SELECT 1 FROM json_each(template.blocks_json) block
            WHERE json_extract(block.value, '$.kind') = 'field'
              AND json_extract(block.value, '$.field_id') = NEW.field_id
         )
    );
  SELECT RAISE(ABORT, 'document_generation_input_definition_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM schema_field_definition_revisions definition
       WHERE definition.tenant_id = NEW.tenant_id
         AND definition.field_id = NEW.field_id
         AND definition.revision_id = NEW.field_definition_revision_id
         AND definition.entity_type = NEW.entity_type
         AND definition.version = NEW.field_definition_version
         AND EXISTS (
           SELECT 1 FROM schema_field_definition_heads field_head
            WHERE field_head.tenant_id = definition.tenant_id
              AND field_head.field_id = definition.field_id
              AND field_head.current_revision_id = definition.revision_id
              AND field_head.current_version = definition.version
         )
    );
  SELECT RAISE(ABORT, 'document_generation_input_value_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM schema_field_value_revisions value
       WHERE value.tenant_id = NEW.tenant_id
         AND value.entity_type = NEW.entity_type
         AND value.entity_id = NEW.entity_id
         AND value.field_id = NEW.field_id
         AND value.value_revision_id = NEW.value_revision_id
         AND value.field_definition_revision_id = NEW.field_definition_revision_id
         AND value.version = NEW.value_version
         AND value.value_digest = NEW.value_digest
         AND value.value_json = NEW.value_json
         AND EXISTS (
           SELECT 1 FROM schema_field_value_heads value_head
            WHERE value_head.tenant_id = value.tenant_id
              AND value_head.value_head_id = value.value_head_id
              AND value_head.entity_type = value.entity_type
              AND value_head.entity_id = value.entity_id
              AND value_head.field_id = value.field_id
              AND value_head.current_revision_id = value.value_revision_id
              AND value_head.current_version = value.version
         )
    );
  SELECT RAISE(ABORT, 'document_generation_input_sequence_invalid')
    WHERE NEW.sequence != COALESCE((
      SELECT MAX(input.sequence) + 1
        FROM document_generation_inputs input
       WHERE input.generation_attempt_id = NEW.generation_attempt_id
    ), 0);
END;

CREATE TRIGGER IF NOT EXISTS document_generation_input_no_insert_replace
BEFORE INSERT ON document_generation_inputs
BEGIN
  SELECT RAISE(ABORT, 'document_generation_inputs_append_only')
    WHERE EXISTS (
      SELECT 1 FROM document_generation_inputs input
       WHERE input.generation_attempt_id = NEW.generation_attempt_id
          AND (input.sequence = NEW.sequence OR input.field_id = NEW.field_id)
    );
END;

CREATE TRIGGER IF NOT EXISTS document_generation_inputs_append_only_update
BEFORE UPDATE ON document_generation_inputs
BEGIN SELECT RAISE(ABORT, 'document_generation_inputs_append_only'); END;

CREATE TRIGGER IF NOT EXISTS document_generation_inputs_append_only_delete
BEFORE DELETE ON document_generation_inputs
BEGIN SELECT RAISE(ABORT, 'document_generation_inputs_append_only'); END;

CREATE TABLE IF NOT EXISTS document_generation_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) BETWEEN 16 AND 240
    AND receipt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  generation_attempt_id TEXT NOT NULL,
  receipt_version INTEGER NOT NULL CHECK (receipt_version BETWEEN 1 AND 1000000),
  prior_receipt_id TEXT,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) BETWEEN 1 AND 80),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 200),
  template_id TEXT NOT NULL,
  template_revision_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version BETWEEN 1 AND 1000000),
  input_snapshot_digest TEXT NOT NULL CHECK (
    length(input_snapshot_digest) = 64 AND input_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  external_effect_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 120),
  provider_document_id TEXT CHECK (
    provider_document_id IS NULL OR (
      length(provider_document_id) BETWEEN 1 AND 240
      AND provider_document_id NOT GLOB '*[^A-Za-z0-9._:/-]*'
    )
  ),
  output_digest TEXT NOT NULL CHECK (
    length(output_digest) = 64 AND output_digest NOT GLOB '*[^0-9a-f]*'
  ),
  readback_digest TEXT CHECK (
    readback_digest IS NULL OR (length(readback_digest) = 64 AND readback_digest NOT GLOB '*[^0-9a-f]*')
  ),
  readback_status TEXT NOT NULL CHECK (readback_status IN ('match', 'conflict', 'not_found', 'unavailable')),
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('succeeded', 'failed', 'unknown')),
  reconciliation_outcome TEXT NOT NULL CHECK (reconciliation_outcome IN ('succeeded', 'failed', 'unknown')),
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('actor', 'service')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'agent', 'worker')),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'ops', 'sales', 'production', 'accounting', 'field')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 160),
  authority_ref TEXT NOT NULL CHECK (length(trim(authority_ref)) BETWEEN 1 AND 280),
  policy_ref TEXT NOT NULL CHECK (length(trim(policy_ref)) BETWEEN 1 AND 280),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 80),
  permit_expires_at TEXT,
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  stop_policy TEXT NOT NULL CHECK (stop_policy IN ('stop_on_unknown', 'stop_on_conflict')),
  compensation_policy TEXT NOT NULL CHECK (compensation_policy IN ('none', 'manual_review')),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (receipt_id, tenant_id),
  UNIQUE (generation_attempt_id, receipt_version),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (generation_attempt_id) REFERENCES document_generation_attempts(generation_attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (external_effect_id) REFERENCES external_effects(effect_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_receipt_id) REFERENCES document_generation_receipts(receipt_id) ON DELETE RESTRICT,
  CHECK (terminal_status = reconciliation_outcome),
  CHECK ((terminal_status = 'succeeded' AND readback_status = 'match' AND provider_document_id IS NOT NULL AND readback_digest IS NOT NULL)
      OR (terminal_status != 'succeeded'))
);

CREATE INDEX IF NOT EXISTS idx_document_generation_receipts_attempt
  ON document_generation_receipts (tenant_id, generation_attempt_id, receipt_version DESC);

CREATE INDEX IF NOT EXISTS idx_document_generation_receipts_scope
  ON document_generation_receipts (tenant_id, entity_type, entity_id, template_id, created_at);

CREATE TRIGGER IF NOT EXISTS document_generation_receipt_insert_guard
BEFORE INSERT ON document_generation_receipts
BEGIN
  SELECT RAISE(ABORT, 'document_generation_receipt_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM document_generation_receipts receipt
       WHERE receipt.receipt_id = NEW.receipt_id
          OR (receipt.tenant_id = NEW.tenant_id
              AND receipt.idempotency_key_hash = NEW.idempotency_key_hash)
          OR (receipt.generation_attempt_id = NEW.generation_attempt_id
              AND receipt.receipt_version = NEW.receipt_version)
    );
  SELECT RAISE(ABORT, 'document_generation_receipt_scope_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM document_generation_attempts attempt
       WHERE attempt.generation_attempt_id = NEW.generation_attempt_id
         AND attempt.tenant_id = NEW.tenant_id
         AND attempt.entity_type = NEW.entity_type
         AND attempt.entity_id = NEW.entity_id
         AND attempt.template_id = NEW.template_id
         AND attempt.template_revision_id = NEW.template_revision_id
         AND attempt.template_version = NEW.template_version
         AND attempt.input_snapshot_digest = NEW.input_snapshot_digest
         AND attempt.output_digest = NEW.output_digest
         AND attempt.external_effect_id = NEW.external_effect_id
         AND attempt.provider = NEW.provider
         AND attempt.authority_kind = NEW.authority_kind
         AND attempt.actor_type = NEW.actor_type
         AND attempt.actor_role = NEW.actor_role
         AND attempt.actor_id = NEW.actor_id
         AND attempt.authority_ref = NEW.authority_ref
         AND attempt.policy_ref = NEW.policy_ref
         AND attempt.policy_version = NEW.policy_version
         AND attempt.permit_expires_at IS NEW.permit_expires_at
         AND attempt.max_attempts = NEW.max_attempts
         AND attempt.stop_policy = NEW.stop_policy
         AND attempt.compensation_policy = NEW.compensation_policy
    );
  SELECT RAISE(ABORT, 'document_generation_receipt_inputs_incomplete')
    WHERE NOT EXISTS (
      SELECT 1
        FROM document_generation_attempts attempt
       WHERE attempt.generation_attempt_id = NEW.generation_attempt_id
         AND (SELECT COUNT(*) FROM document_generation_inputs input
               WHERE input.generation_attempt_id = NEW.generation_attempt_id) = attempt.input_count
    );
  SELECT RAISE(ABORT, 'document_generation_receipt_prior_invalid')
    WHERE (NEW.receipt_version = 1 AND NEW.prior_receipt_id IS NOT NULL)
       OR (NEW.receipt_version > 1 AND NOT EXISTS (
         SELECT 1 FROM document_generation_receipts prior
          WHERE prior.receipt_id = NEW.prior_receipt_id
            AND prior.generation_attempt_id = NEW.generation_attempt_id
            AND prior.receipt_version = NEW.receipt_version - 1
            AND prior.terminal_status = 'unknown'
       ));
  SELECT RAISE(ABORT, 'document_generation_receipt_effect_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.provider = NEW.provider
         AND effect.intent_id = NEW.generation_attempt_id
         AND effect.action = 'document.generate'
         AND effect.aggregate_type = 'document_generation'
         AND effect.aggregate_id = NEW.generation_attempt_id
         AND effect.aggregate_version = NEW.template_version
    );
  SELECT RAISE(ABORT, 'document_generation_retry_budget_invalid')
    WHERE EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.provider = NEW.provider
         AND effect.intent_id = NEW.generation_attempt_id
         AND effect.action = 'document.generate'
         AND effect.aggregate_type = 'document_generation'
         AND effect.aggregate_id = NEW.generation_attempt_id
         AND effect.aggregate_version = NEW.template_version
         AND effect.retry_limit + 1 > NEW.max_attempts
    );
  SELECT RAISE(ABORT, 'document_generation_readback_invalid')
    WHERE EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND ((effect.state = 'manual_exception' AND NEW.readback_status != 'conflict')
           OR (effect.state = 'unknown' AND NEW.readback_status = 'conflict'))
    );
  SELECT RAISE(ABORT, 'document_generation_retry_budget_invalid')
    WHERE NEW.terminal_status = 'failed'
      AND EXISTS (
        SELECT 1 FROM external_effects effect
         WHERE effect.effect_id = NEW.external_effect_id
           AND effect.tenant_id = NEW.tenant_id
           AND effect.provider = NEW.provider
           AND effect.intent_id = NEW.generation_attempt_id
           AND effect.action = 'document.generate'
           AND effect.aggregate_type = 'document_generation'
           AND effect.aggregate_id = NEW.generation_attempt_id
           AND effect.aggregate_version = NEW.template_version
           AND effect.state = 'failed'
           AND effect.attempt_count < effect.retry_limit + 1
      );
  SELECT RAISE(ABORT, 'document_generation_receipt_terminal_invalid')
    WHERE (NEW.terminal_status = 'succeeded' AND NOT EXISTS (
      SELECT 1
        FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.state = 'succeeded'
         AND effect.provider_external_id = NEW.provider_document_id
         AND effect.readback_hash = NEW.readback_digest
         AND json_valid(effect.expected_readback_json)
         AND (SELECT COUNT(*) FROM json_each(effect.expected_readback_json)) = 12
         AND json_extract(effect.expected_readback_json, '$.schema_version') = 'ironwrap.document-generation-readback.v1'
         AND json_extract(effect.expected_readback_json, '$.tenant_id') = NEW.tenant_id
         AND json_extract(effect.expected_readback_json, '$.entity_type') = NEW.entity_type
         AND json_extract(effect.expected_readback_json, '$.entity_id') = NEW.entity_id
         AND json_extract(effect.expected_readback_json, '$.generation_attempt_id') = NEW.generation_attempt_id
         AND json_extract(effect.expected_readback_json, '$.template_id') = NEW.template_id
         AND json_extract(effect.expected_readback_json, '$.template_revision_id') = NEW.template_revision_id
         AND json_extract(effect.expected_readback_json, '$.template_version') = NEW.template_version
         AND json_extract(effect.expected_readback_json, '$.input_snapshot_digest') = NEW.input_snapshot_digest
         AND json_extract(effect.expected_readback_json, '$.provider') = NEW.provider
         AND json_extract(effect.expected_readback_json, '$.provider_document_id') = NEW.provider_document_id
         AND json_extract(effect.expected_readback_json, '$.output_digest') = NEW.output_digest
    ))
       OR (NEW.terminal_status = 'failed' AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.state = 'failed'
         AND effect.attempt_count >= effect.retry_limit + 1
         AND effect.provider_external_id IS NEW.provider_document_id
         AND effect.readback_hash IS NEW.readback_digest
    ))
       OR (NEW.terminal_status = 'unknown' AND NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.state IN ('unknown', 'manual_exception')
         AND effect.provider_external_id IS NEW.provider_document_id
         AND effect.readback_hash IS NEW.readback_digest
    ));
END;

CREATE TRIGGER IF NOT EXISTS document_generation_receipt_no_insert_replace
BEFORE INSERT ON document_generation_receipts
BEGIN
  SELECT RAISE(ABORT, 'document_generation_receipts_append_only')
    WHERE EXISTS (
      SELECT 1 FROM document_generation_receipts receipt
       WHERE receipt.receipt_id = NEW.receipt_id
          OR (receipt.tenant_id = NEW.tenant_id
              AND receipt.idempotency_key_hash = NEW.idempotency_key_hash)
          OR (receipt.generation_attempt_id = NEW.generation_attempt_id
              AND receipt.receipt_version = NEW.receipt_version)
    );
END;

CREATE TRIGGER IF NOT EXISTS document_generation_receipts_append_only_update
BEFORE UPDATE ON document_generation_receipts
BEGIN SELECT RAISE(ABORT, 'document_generation_receipts_append_only'); END;

CREATE TRIGGER IF NOT EXISTS document_generation_receipts_append_only_delete
BEFORE DELETE ON document_generation_receipts
BEGIN SELECT RAISE(ABORT, 'document_generation_receipts_append_only'); END;
