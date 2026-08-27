-- 0122_pipeline_admin_configuration.sql - administrator-configurable pipelines (IRO-209).
--
-- Additive expand over 0113_pipeline_board_core.sql.  Nothing here names a vertical: this is the
-- storage an administrator needs to create, edit, reorder, copy, archive and role-scope an
-- unrestricted number of pipelines WITHOUT a developer and without the Frappe desk.
--
-- Four additions, and the reason each one exists:
--
--   1. `pipeline_stages.is_active` - a stage an administrator removes after cards have passed
--      through it cannot be deleted: `pipeline_card_transitions` is append-only and holds
--      ON DELETE RESTRICT foreign keys to the stage.  Archiving takes it off every board and out
--      of adjacency while the audit trail it is named in stays readable.  A stage that never held
--      a card is still hard-deleted, so a typo leaves no residue.
--
--   2. `pipeline_role_grants` - per-pipeline role scoping that holds MORE THAN ONE role from day
--      one (a shop pipeline is read by production and written by ops).  `pipelines.owning_role`
--      keeps its meaning and its fail-closed shape from PR #171; a grant row only ever ADDS a
--      role, so a pipeline with no grants behaves exactly as it does today.
--
--   3. `pipeline_configuration_events` - append-only evidence for configuration changes, written
--      in the same D1 batch as the change it describes.  Who archived a board, and when, is a
--      question an owner asks the day after, not something to reconstruct from a diff.
--
--   4. `pipelines.configuration_marker` - the request-unique proof that makes a batched
--      administration command safe against a stale writer.  See the column comment below.
--
-- Deliberately absent: any cap on the number of pipelines a tenant may hold.  The stakeholder runs
-- sales, production, commercial and material-resale boards per office and asked for as many as the
-- business needs, so neither this schema nor the read path bounds them.

ALTER TABLE pipeline_stages
  ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));

-- The request-unique marker an administration command stamps on the pipeline row when its version
-- CAS lands, so every dependent statement in the same batch can prove IT was the writer that won.
--
-- D1 reports a statement matching zero rows as a SUCCESS.  Every dependent write therefore carries
-- the marker predicate, and the append-only event is an in-batch assertion of the aggregate (and,
-- for destructive commands, the dependent mutation).  A failed assertion violates a NOT NULL
-- column and rolls the whole batch back: a stale writer cannot leave an earlier CAS or child row
-- committed.  This is the same shape as `pipeline_cards.last_transition_id` in 0113.
ALTER TABLE pipelines
  ADD COLUMN configuration_marker TEXT CHECK (
    configuration_marker IS NULL OR (
      length(configuration_marker) BETWEEN 8 AND 200
      AND configuration_marker NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  );

-- The board reads only live stages, and adjacency is the ordered index of that live list, so an
-- archived stage cannot silently redefine what "forward by exactly one stage" means.
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_live
  ON pipeline_stages (tenant_id, pipeline_id, is_active, position);

-- A grant row IS read access for that role on that pipeline; `can_write` adds card movement on
-- top.  There is no "explicitly denied" row: absence is the deny, which is what keeps the read
-- path fail-closed with a single check instead of a precedence table.
CREATE TABLE IF NOT EXISTS pipeline_role_grants (
  grant_id TEXT PRIMARY KEY CHECK (
    length(grant_id) BETWEEN 8 AND 200
    AND grant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  pipeline_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (length(role) BETWEEN 2 AND 40 AND role NOT GLOB '*[^a-z_]*'),
  can_write INTEGER NOT NULL DEFAULT 0 CHECK (can_write IN (0, 1)),
  granted_by TEXT NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (grant_id, tenant_id),
  UNIQUE (tenant_id, pipeline_id, role),
  FOREIGN KEY (pipeline_id, tenant_id)
    REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_role_grants_role
  ON pipeline_role_grants (tenant_id, role, pipeline_id);

-- Append-only configuration evidence.  `stage_id` deliberately carries NO foreign key: a stage
-- that never held a card is hard-deleted, and an ON DELETE RESTRICT edge from here would turn the
-- record of that removal into the thing preventing it.
CREATE TABLE IF NOT EXISTS pipeline_configuration_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 12 AND 200
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  pipeline_id TEXT NOT NULL,
  stage_id TEXT CHECK (stage_id IS NULL OR length(stage_id) BETWEEN 8 AND 200),
  action TEXT NOT NULL CHECK (
    action IN (
      'pipeline_created',
      'pipeline_updated',
      'pipeline_copied',
      'pipelines_reordered',
      'stage_added',
      'stage_updated',
      'stage_removed',
      'stage_archived',
      'stages_reordered',
      'role_grants_replaced'
    )
  ),
  actor_role TEXT NOT NULL CHECK (length(actor_role) BETWEEN 2 AND 40),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  pipeline_version INTEGER NOT NULL CHECK (pipeline_version BETWEEN 1 AND 1000000),
  detail_json TEXT NOT NULL CHECK (
    json_valid(detail_json) AND length(detail_json) BETWEEN 2 AND 4000
  ),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  UNIQUE (event_id, tenant_id),
  -- One event per pipeline version per action: the version a command lands on is its receipt, so
  -- a retried command cannot double-write the history of a change that happened once.
  UNIQUE (tenant_id, pipeline_id, pipeline_version, action, stage_id),
  FOREIGN KEY (pipeline_id, tenant_id)
    REFERENCES pipelines(pipeline_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_configuration_events_pipeline
  ON pipeline_configuration_events (tenant_id, pipeline_id, occurred_at, event_id);

CREATE TRIGGER IF NOT EXISTS pipeline_configuration_events_append_only_update
BEFORE UPDATE ON pipeline_configuration_events
BEGIN SELECT RAISE(ABORT, 'pipeline_configuration_events_append_only'); END;

CREATE TRIGGER IF NOT EXISTS pipeline_configuration_events_append_only_delete
BEFORE DELETE ON pipeline_configuration_events
BEGIN SELECT RAISE(ABORT, 'pipeline_configuration_events_append_only'); END;

-- A grant is scoped to one pipeline for one role for the life of the row.  Re-scoping is a delete
-- plus an insert under the pipeline's own version CAS, never an in-place rewrite that would leave
-- the configuration event pointing at a role the row no longer names.
CREATE TRIGGER IF NOT EXISTS pipeline_role_grants_identity_guard
BEFORE UPDATE ON pipeline_role_grants
WHEN NEW.grant_id != OLD.grant_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.pipeline_id != OLD.pipeline_id OR NEW.role != OLD.role
  OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'pipeline_role_grants_identity_immutable'); END;
