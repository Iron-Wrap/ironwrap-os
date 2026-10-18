-- A person's answer to "did this crew item arrive?" for an item the crew phone holds as
-- unconfirmed: the office answered, but the phone could not verify that the office holds that
-- exact item.
--
-- One append-only row per answer, bound to the exact saved item: the device action id the phone
-- used as its Idempotency-Key, the item kind, and the Worker's own stored request hash for that
-- crew write (`payload_sha256`). `arrived` and `duplicate` cite the stored crew write itself as
-- the linked record; `not_arrived` cites nothing and carries no hash, because nothing was stored
-- to hash. A person (an active owner or ops user of the same tenant) is always the resolver; an AI
-- proposal reference is provenance only and never substitutes for that person.
CREATE TABLE field_item_resolutions (
  resolution_id TEXT PRIMARY KEY CHECK (
    length(resolution_id) = 68 AND resolution_id GLOB 'fir_*'
    AND substr(resolution_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64 AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  device_action_id TEXT NOT NULL CHECK (
    length(device_action_id) BETWEEN 8 AND 200
    AND device_action_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  item_kind TEXT NOT NULL CHECK (item_kind IN (
    'field_checkin', 'work_package_acknowledgement', 'work_package_stop', 'inventory_command',
    'inventory_scan', 'safety_action', 'fleet_pre_trip_inspection', 'fleet_post_trip_inspection',
    'fleet_defect_report', 'schema_field_value'
  )),
  payload_sha256 TEXT CHECK (
    payload_sha256 IS NULL
    OR (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  resolution TEXT NOT NULL CHECK (resolution IN ('arrived', 'not_arrived', 'duplicate')),
  linked_record_type TEXT CHECK (linked_record_type IS NULL OR linked_record_type IN (
    'field_action', 'work_package_action', 'fleet_asset_action', 'safety_device_action',
    'inventory_scan', 'inventory_command', 'schema_field_value_revision'
  )),
  linked_record_id TEXT CHECK (
    linked_record_id IS NULL
    OR (length(linked_record_id) BETWEEN 1 AND 220
      AND linked_record_id NOT GLOB '*[^A-Za-z0-9._:-]*')
  ),
  crew_user_id TEXT NOT NULL CHECK (length(crew_user_id) BETWEEN 1 AND 160),
  crew_device_id TEXT CHECK (crew_device_id IS NULL OR length(crew_device_id) BETWEEN 8 AND 160),
  resolved_by_user_id TEXT NOT NULL CHECK (length(resolved_by_user_id) BETWEEN 1 AND 160),
  resolved_by_role TEXT NOT NULL CHECK (resolved_by_role IN ('owner', 'ops')),
  proposed_by_agent_id TEXT CHECK (
    proposed_by_agent_id IS NULL OR proposed_by_agent_id = 'field_safety'
  ),
  proposal_evidence_id TEXT CHECK (
    proposal_evidence_id IS NULL
    OR (length(proposal_evidence_id) BETWEEN 8 AND 200
      AND proposal_evidence_id NOT GLOB '*[^A-Za-z0-9._:-]*')
  ),
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 58 AND request_id GLOB 'field-item-resolution:*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, request_id),
  CHECK ((resolution = 'not_arrived') = (payload_sha256 IS NULL)),
  CHECK ((resolution = 'not_arrived') = (linked_record_type IS NULL)),
  CHECK ((linked_record_type IS NULL) = (linked_record_id IS NULL)),
  CHECK ((proposed_by_agent_id IS NULL) = (proposal_evidence_id IS NULL)),
  CHECK (resolution != 'not_arrived' OR crew_device_id IS NULL),
  FOREIGN KEY (crew_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

-- The crew read looks items up by tenant and device action id.
CREATE INDEX idx_field_item_resolutions_item
  ON field_item_resolutions (tenant_id, device_action_id);

-- One resolution per (tenant, device action id, payload hash). A `not_arrived` answer has no
-- hash, so it is unique per (tenant, device action id) on its own; a later `arrived` for the same
-- item after the phone's single resend carries the stored hash and is a different key.
CREATE UNIQUE INDEX idx_field_item_resolutions_bound
  ON field_item_resolutions (tenant_id, device_action_id, payload_sha256)
  WHERE payload_sha256 IS NOT NULL;

CREATE UNIQUE INDEX idx_field_item_resolutions_unbound
  ON field_item_resolutions (tenant_id, device_action_id)
  WHERE payload_sha256 IS NULL;

-- The resolver is a person: an active owner or ops user of the same tenant whose role at the
-- moment of the write is the recorded one. The crew member is a field user of the same tenant.
-- An agent, service, effect runtime or MCP actor has no app user row, so it can never be either.
CREATE TRIGGER field_item_resolutions_person_guard
BEFORE INSERT ON field_item_resolutions
BEGIN
  SELECT RAISE(ABORT, 'field_item_resolution_person_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS person
     WHERE person.user_id = NEW.resolved_by_user_id
       AND person.tenant_id = NEW.tenant_id
       AND person.active = 1
       AND COALESCE(person.access_role, person.role) = NEW.resolved_by_role
  );
  SELECT RAISE(ABORT, 'field_item_resolution_crew_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS crew
     WHERE crew.user_id = NEW.crew_user_id
       AND crew.tenant_id = NEW.tenant_id
       AND COALESCE(crew.access_role, crew.role) = 'field'
  );
END;

-- Append-only: no update, no delete, and no INSERT OR REPLACE over an earlier answer, request id
-- or item key.
CREATE TRIGGER field_item_resolutions_no_replace
BEFORE INSERT ON field_item_resolutions
WHEN EXISTS (
  SELECT 1 FROM field_item_resolutions
   WHERE resolution_id = NEW.resolution_id
      OR (tenant_id = NEW.tenant_id AND request_id = NEW.request_id)
      OR (tenant_id = NEW.tenant_id AND device_action_id = NEW.device_action_id
        AND payload_sha256 IS NEW.payload_sha256)
)
BEGIN
  SELECT RAISE(ABORT, 'field_item_resolution_immutable');
END;

CREATE TRIGGER field_item_resolutions_no_update
BEFORE UPDATE ON field_item_resolutions
BEGIN
  SELECT RAISE(ABORT, 'field_item_resolution_immutable');
END;

CREATE TRIGGER field_item_resolutions_no_delete
BEFORE DELETE ON field_item_resolutions
BEGIN
  SELECT RAISE(ABORT, 'field_item_resolution_immutable');
END;
