-- 0113_pipeline_board_core.sql - the generic pipeline board core (IRO-209).
--
-- Nothing in this file names a vertical.  A pipeline is a named, ordered sequence of stages over
-- cards, and a card binds to any entity type by (entity_type, entity_id).  The seven Sales stage
-- names the stakeholder uses are seed DATA (config/pipelines/sales-pipeline.v1.json), not schema.
--
-- SQLite cannot express a polymorphic foreign key, so referential integrity from
-- pipeline_cards.(entity_type, entity_id) to the real entity table is enforced at the API layer by
-- the entity-type registry in src/pipeline-board-store.ts.  That gap is deliberate and documented:
-- enumerating entity types here would force a migration the day a module supplies a new one.

CREATE TABLE IF NOT EXISTS pipelines (
  pipeline_id TEXT PRIMARY KEY CHECK (
    length(pipeline_id) BETWEEN 8 AND 200
    AND pipeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 60 AND key NOT GLOB '*[^a-z0-9_]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  entity_type TEXT NOT NULL CHECK (
    length(entity_type) BETWEEN 2 AND 40 AND entity_type NOT GLOB '*[^a-z_]*'
  ),
  owning_role TEXT CHECK (owning_role IS NULL OR length(owning_role) BETWEEN 2 AND 40),
  card_template_json TEXT NOT NULL CHECK (
    json_valid(card_template_json) AND length(card_template_json) BETWEEN 2 AND 8000
  ),
  is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0, 1)),
  template_source_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 1000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (pipeline_id, tenant_id),
  UNIQUE (tenant_id, key),
  FOREIGN KEY (template_source_id, tenant_id)
    REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pipelines_tenant_active
  ON pipelines (tenant_id, is_active, position, pipeline_id);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  stage_id TEXT PRIMARY KEY CHECK (
    length(stage_id) BETWEEN 8 AND 200
    AND stage_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  pipeline_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 60 AND key NOT GLOB '*[^a-z0-9_]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  color TEXT CHECK (color IS NULL OR length(color) BETWEEN 3 AND 20),
  -- `position` orders the board.  Adjacency (the "forward by exactly one stage" safeguard rule) is
  -- computed from the ORDERED INDEX of the stage list, never from the raw value, so gaps and an
  -- M3 reorder that briefly collides two positions can never silently redefine what "adjacent"
  -- means.  That is also why no UNIQUE sits on this column: a swap must not need a temp value.
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 1000000),
  is_won INTEGER NOT NULL DEFAULT 0 CHECK (is_won IN (0, 1)),
  is_lost INTEGER NOT NULL DEFAULT 0 CHECK (is_lost IN (0, 1)),
  min_role_to_enter TEXT CHECK (
    min_role_to_enter IS NULL OR length(min_role_to_enter) BETWEEN 2 AND 40
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (stage_id, tenant_id),
  UNIQUE (stage_id, tenant_id, pipeline_id),
  UNIQUE (tenant_id, pipeline_id, key),
  CHECK (is_won = 0 OR is_lost = 0),
  FOREIGN KEY (pipeline_id, tenant_id) REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_board
  ON pipeline_stages (tenant_id, pipeline_id, position);

CREATE TABLE IF NOT EXISTS pipeline_cards (
  card_id TEXT PRIMARY KEY CHECK (
    length(card_id) BETWEEN 8 AND 200
    AND card_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  pipeline_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (
    length(entity_type) BETWEEN 2 AND 40 AND entity_type NOT GLOB '*[^a-z_]*'
  ),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 200),
  position_in_stage REAL NOT NULL CHECK (position_in_stage BETWEEN 0 AND 1000000000),
  stage_entered_at TEXT NOT NULL CHECK (length(stage_entered_at) BETWEEN 20 AND 40),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  -- Set to the transition request that won the version CAS.  The following transition INSERT must
  -- match this marker, so a stale writer cannot audit the winner's already-advanced card state.
  last_transition_id TEXT CHECK (
    last_transition_id IS NULL OR (
      length(last_transition_id) BETWEEN 12 AND 200
      AND last_transition_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (card_id, tenant_id),
  UNIQUE (card_id, tenant_id, pipeline_id),
  UNIQUE (tenant_id, pipeline_id, entity_type, entity_id),
  FOREIGN KEY (pipeline_id, tenant_id) REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (stage_id, tenant_id, pipeline_id)
    REFERENCES pipeline_stages(stage_id, tenant_id, pipeline_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_cards_board
  ON pipeline_cards (tenant_id, pipeline_id, stage_id, position_in_stage);

CREATE INDEX IF NOT EXISTS idx_pipeline_cards_entity
  ON pipeline_cards (tenant_id, entity_type, entity_id);

-- Append-only audit trail.  An undo never deletes: it inserts a new row with safeguard 'undo' and
-- correlation_id pointing at the transition it reverses.
CREATE TABLE IF NOT EXISTS pipeline_card_transitions (
  transition_id TEXT PRIMARY KEY CHECK (
    length(transition_id) BETWEEN 12 AND 200
    AND transition_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  pipeline_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  from_stage_id TEXT,
  to_stage_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('owner', 'worker', 'agent', 'customer', 'device', 'external_authority')
  ),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  safeguard TEXT NOT NULL CHECK (safeguard IN ('direct', 'confirmed', 'undo')),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  correlation_id TEXT CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 8 AND 160),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  card_version INTEGER NOT NULL CHECK (card_version BETWEEN 1 AND 1000000),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (transition_id, tenant_id),
  UNIQUE (transition_id, tenant_id, pipeline_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  CHECK (safeguard != 'undo' OR correlation_id IS NOT NULL),
  FOREIGN KEY (pipeline_id, tenant_id) REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (card_id, tenant_id, pipeline_id)
    REFERENCES pipeline_cards(card_id, tenant_id, pipeline_id) ON DELETE RESTRICT,
  FOREIGN KEY (from_stage_id, tenant_id, pipeline_id)
    REFERENCES pipeline_stages(stage_id, tenant_id, pipeline_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_stage_id, tenant_id, pipeline_id)
    REFERENCES pipeline_stages(stage_id, tenant_id, pipeline_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_card_transitions_card
  ON pipeline_card_transitions (tenant_id, card_id, occurred_at, transition_id);

CREATE INDEX IF NOT EXISTS idx_pipeline_card_transitions_correlation
  ON pipeline_card_transitions (tenant_id, correlation_id);

-- M4 automation hook.  Populated atomically with every transition and never drained here, so the
-- rule engine ships in M4 with zero backlog of un-notified historical moves.  No consumer exists.
CREATE TABLE IF NOT EXISTS pipeline_stage_automation_outbox (
  outbox_id TEXT PRIMARY KEY CHECK (
    length(outbox_id) BETWEEN 12 AND 200
    AND outbox_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  pipeline_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  from_stage_id TEXT,
  to_stage_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'claimed', 'done', 'failed')
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (outbox_id, tenant_id),
  UNIQUE (tenant_id, transition_id),
  UNIQUE (transition_id, tenant_id, pipeline_id),
  FOREIGN KEY (pipeline_id, tenant_id) REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (card_id, tenant_id, pipeline_id)
    REFERENCES pipeline_cards(card_id, tenant_id, pipeline_id) ON DELETE RESTRICT,
  FOREIGN KEY (transition_id, tenant_id, pipeline_id)
    REFERENCES pipeline_card_transitions(transition_id, tenant_id, pipeline_id) ON DELETE RESTRICT,
  FOREIGN KEY (from_stage_id, tenant_id, pipeline_id)
    REFERENCES pipeline_stages(stage_id, tenant_id, pipeline_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_stage_id, tenant_id, pipeline_id)
    REFERENCES pipeline_stages(stage_id, tenant_id, pipeline_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stage_automation_outbox_pending
  ON pipeline_stage_automation_outbox (tenant_id, status, created_at, outbox_id);

-- Mutable rows use the monotonic-version CAS idiom of 0090_operating_core.sql: a writer must
-- present the version it read, and the trigger refuses anything that is not exactly +1.
CREATE TRIGGER IF NOT EXISTS pipelines_version_guard
BEFORE UPDATE ON pipelines
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'pipelines_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS pipeline_stages_version_guard
BEFORE UPDATE ON pipeline_stages
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'pipeline_stages_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS pipeline_cards_version_guard
BEFORE UPDATE ON pipeline_cards
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'pipeline_cards_version_conflict'); END;

-- Identity is immutable.  A stage `key` in particular never changes, so an M4 automation rule or a
-- saved client view keyed on it survives an administrator renaming the visible label.
CREATE TRIGGER IF NOT EXISTS pipelines_identity_guard
BEFORE UPDATE ON pipelines
WHEN NEW.pipeline_id != OLD.pipeline_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.key != OLD.key OR NEW.entity_type != OLD.entity_type
  OR NEW.template_source_id IS NOT OLD.template_source_id
  OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'pipelines_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS pipeline_stages_identity_guard
BEFORE UPDATE ON pipeline_stages
WHEN NEW.stage_id != OLD.stage_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.pipeline_id != OLD.pipeline_id OR NEW.key != OLD.key
  OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'pipeline_stages_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS pipeline_cards_identity_guard
BEFORE UPDATE ON pipeline_cards
WHEN NEW.card_id != OLD.card_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.pipeline_id != OLD.pipeline_id OR NEW.entity_type != OLD.entity_type
  OR NEW.entity_id != OLD.entity_id OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'pipeline_cards_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS pipeline_card_transitions_append_only_update
BEFORE UPDATE ON pipeline_card_transitions
BEGIN SELECT RAISE(ABORT, 'pipeline_card_transitions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS pipeline_card_transitions_append_only_delete
BEFORE DELETE ON pipeline_card_transitions
BEGIN SELECT RAISE(ABORT, 'pipeline_card_transitions_append_only'); END;

-- The outbox row is written once with the transition.  Only `status` moves, and only forward, so
-- an M4 consumer can claim work without ever rewriting the fact that the move happened.
CREATE TRIGGER IF NOT EXISTS pipeline_stage_automation_outbox_append_only_update
BEFORE UPDATE ON pipeline_stage_automation_outbox
WHEN NEW.outbox_id != OLD.outbox_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.pipeline_id != OLD.pipeline_id OR NEW.card_id != OLD.card_id
  OR NEW.transition_id != OLD.transition_id
  OR NEW.from_stage_id IS NOT OLD.from_stage_id OR NEW.to_stage_id != OLD.to_stage_id
  OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'pipeline_stage_automation_outbox_append_only'); END;

CREATE TRIGGER IF NOT EXISTS pipeline_stage_automation_outbox_append_only_delete
BEFORE DELETE ON pipeline_stage_automation_outbox
BEGIN SELECT RAISE(ABORT, 'pipeline_stage_automation_outbox_append_only'); END;
