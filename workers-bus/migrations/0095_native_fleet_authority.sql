-- 0095_native_fleet_authority.sql - D1-owned fleet identity, custody, safety, and capture facts.
--
-- R2 remains the immutable raw-evidence store and fleet_asset_actions remains the device
-- idempotency/lease ledger. These tables replace Frappe as the required fleet authority.

CREATE TABLE IF NOT EXISTS fleet_crews (
  crew_id TEXT PRIMARY KEY CHECK (
    length(crew_id) BETWEEN 8 AND 140
    AND crew_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('Active', 'Inactive')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (crew_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS fleet_crew_members (
  membership_id TEXT PRIMARY KEY CHECK (
    length(membership_id) BETWEEN 8 AND 180
    AND membership_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL,
  crew_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, crew_id, user_id),
  FOREIGN KEY (crew_id, tenant_id) REFERENCES fleet_crews(crew_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fleet_assets (
  fleet_asset_id TEXT PRIMARY KEY CHECK (
    length(fleet_asset_id) BETWEEN 1 AND 140
    AND fleet_asset_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  unit_number TEXT CHECK (unit_number IS NULL OR length(trim(unit_number)) BETWEEN 1 AND 80),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('Vehicle', 'Trailer', 'Equipment', 'Tool')),
  status TEXT NOT NULL CHECK (status IN ('Draft', 'Active', 'Out of Service', 'Retired')),
  licence_plate TEXT CHECK (licence_plate IS NULL OR length(trim(licence_plate)) BETWEEN 1 AND 40),
  meter_kind TEXT CHECK (meter_kind IS NULL OR meter_kind IN ('Odometer km', 'Engine hours')),
  current_meter_milli INTEGER CHECK (
    current_meter_milli IS NULL OR (typeof(current_meter_milli) = 'integer' AND current_meter_milli >= 0)
  ),
  required_licence_class TEXT CHECK (
    required_licence_class IS NULL OR length(trim(required_licence_class)) BETWEEN 1 AND 40
  ),
  payload_capacity_kg_milli INTEGER CHECK (
    payload_capacity_kg_milli IS NULL
    OR (typeof(payload_capacity_kg_milli) = 'integer' AND payload_capacity_kg_milli >= 0)
  ),
  inspection_authority_source TEXT NOT NULL DEFAULT 'Physical Inspection' CHECK (
    inspection_authority_source IN ('Physical Inspection', 'Telematics')
  ),
  last_inspection_id TEXT,
  last_inspection_at TEXT CHECK (last_inspection_at IS NULL OR length(last_inspection_at) BETWEEN 20 AND 40),
  next_inspection_due TEXT CHECK (next_inspection_due IS NULL OR length(next_inspection_due) = 10),
  next_service_due_date TEXT CHECK (next_service_due_date IS NULL OR length(next_service_due_date) = 10),
  calibration_required INTEGER NOT NULL DEFAULT 0 CHECK (calibration_required IN (0, 1)),
  next_calibration_due TEXT CHECK (next_calibration_due IS NULL OR length(next_calibration_due) = 10),
  registration_expiry TEXT CHECK (registration_expiry IS NULL OR length(registration_expiry) = 10),
  insurance_expiry TEXT CHECK (insurance_expiry IS NULL OR length(insurance_expiry) = 10),
  out_of_service_reason TEXT CHECK (
    out_of_service_reason IS NULL OR length(trim(out_of_service_reason)) BETWEEN 1 AND 1200
  ),
  out_of_service_at TEXT CHECK (out_of_service_at IS NULL OR length(out_of_service_at) BETWEEN 20 AND 40),
  custody_holder_type TEXT NOT NULL CHECK (custody_holder_type IN ('User', 'Crew', 'Yard')),
  custody_user_id TEXT,
  custody_crew_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  last_command_id TEXT NOT NULL CHECK (length(last_command_id) BETWEEN 8 AND 180),
  last_actor_user_id TEXT NOT NULL,
  last_evidence_key TEXT CHECK (last_evidence_key IS NULL OR length(last_evidence_key) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (fleet_asset_id, tenant_id),
  CHECK (
    (custody_holder_type = 'User' AND custody_user_id IS NOT NULL AND custody_crew_id IS NULL)
    OR (custody_holder_type = 'Crew' AND custody_user_id IS NULL AND custody_crew_id IS NOT NULL)
    OR (custody_holder_type = 'Yard' AND custody_user_id IS NULL AND custody_crew_id IS NULL)
  ),
  CHECK (
    (status = 'Out of Service' AND out_of_service_reason IS NOT NULL AND out_of_service_at IS NOT NULL)
    OR (status != 'Out of Service' AND out_of_service_reason IS NULL AND out_of_service_at IS NULL)
  ),
  FOREIGN KEY (custody_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (custody_crew_id, tenant_id) REFERENCES fleet_crews(crew_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (last_actor_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fleet_driver_authorities (
  driver_authority_id TEXT PRIMARY KEY CHECK (
    length(driver_authority_id) BETWEEN 8 AND 140
    AND driver_authority_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Draft', 'Active', 'Suspended', 'Expired', 'Retired')),
  authority_source TEXT NOT NULL CHECK (authority_source IN ('Physical Document', 'Telematics')),
  licence_class TEXT NOT NULL CHECK (length(trim(licence_class)) BETWEEN 1 AND 120),
  licence_expiry TEXT NOT NULL CHECK (length(licence_expiry) = 10),
  medical_expiry TEXT CHECK (medical_expiry IS NULL OR length(medical_expiry) = 10),
  evidence_key TEXT NOT NULL CHECK (length(evidence_key) BETWEEN 1 AND 512),
  evidence_sha256 TEXT NOT NULL CHECK (
    length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  last_command_id TEXT NOT NULL CHECK (length(last_command_id) BETWEEN 8 AND 180),
  last_actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (driver_authority_id, tenant_id),
  UNIQUE (tenant_id, user_id, version),
  FOREIGN KEY (user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (last_actor_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fleet_cargo_loads (
  cargo_load_id TEXT PRIMARY KEY CHECK (
    length(cargo_load_id) BETWEEN 8 AND 180
    AND cargo_load_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  fleet_asset_id TEXT NOT NULL,
  trailer_asset_id TEXT,
  driver_authority_id TEXT,
  driver_user_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('Draft', 'Loaded', 'In Transit', 'Delivered', 'Returned', 'Reconciled', 'Cancelled')
  ),
  loaded_weight_kg_milli INTEGER CHECK (
    loaded_weight_kg_milli IS NULL
    OR (typeof(loaded_weight_kg_milli) = 'integer' AND loaded_weight_kg_milli >= 0)
  ),
  custody_holder_type TEXT CHECK (custody_holder_type IS NULL OR custody_holder_type IN ('User', 'Crew', 'Yard')),
  custody_user_id TEXT,
  custody_crew_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  last_command_id TEXT NOT NULL CHECK (length(last_command_id) BETWEEN 8 AND 180),
  last_actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (cargo_load_id, tenant_id),
  CHECK (trailer_asset_id IS NULL OR trailer_asset_id != fleet_asset_id),
  CHECK (
    status IN ('Draft', 'Cancelled')
    OR (driver_authority_id IS NOT NULL AND driver_user_id IS NOT NULL
        AND loaded_weight_kg_milli IS NOT NULL AND custody_holder_type IS NOT NULL)
  ),
  CHECK (
    custody_holder_type IS NULL
    OR (custody_holder_type = 'User' AND custody_user_id IS NOT NULL AND custody_crew_id IS NULL)
    OR (custody_holder_type = 'Crew' AND custody_user_id IS NULL AND custody_crew_id IS NOT NULL)
    OR (custody_holder_type = 'Yard' AND custody_user_id IS NULL AND custody_crew_id IS NULL)
  ),
  FOREIGN KEY (roof_job_id, tenant_id) REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (fleet_asset_id, tenant_id) REFERENCES fleet_assets(fleet_asset_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (trailer_asset_id, tenant_id) REFERENCES fleet_assets(fleet_asset_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (driver_authority_id, tenant_id) REFERENCES fleet_driver_authorities(driver_authority_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (driver_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (custody_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (custody_crew_id, tenant_id) REFERENCES fleet_crews(crew_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (last_actor_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fleet_asset_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  fleet_asset_id TEXT NOT NULL,
  asset_version INTEGER NOT NULL CHECK (asset_version BETWEEN 1 AND 1000000),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('created', 'state_changed')),
  command_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  evidence_key TEXT,
  snapshot_json TEXT NOT NULL CHECK (length(snapshot_json) BETWEEN 2 AND 32768 AND json_valid(snapshot_json)),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, fleet_asset_id, asset_version),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (fleet_asset_id, tenant_id) REFERENCES fleet_assets(fleet_asset_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fleet_inspections (
  inspection_id TEXT PRIMARY KEY CHECK (
    length(inspection_id) BETWEEN 8 AND 180
    AND inspection_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  device_action_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  fleet_asset_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  inspection_type TEXT NOT NULL CHECK (inspection_type IN ('Pre-Trip', 'Post-Trip')),
  performed_at TEXT NOT NULL CHECK (length(performed_at) BETWEEN 20 AND 40),
  meter_reading_milli INTEGER CHECK (
    meter_reading_milli IS NULL
    OR (typeof(meter_reading_milli) = 'integer' AND meter_reading_milli >= 0)
  ),
  telematics_reference TEXT CHECK (
    telematics_reference IS NULL OR length(trim(telematics_reference)) BETWEEN 1 AND 140
  ),
  items_json TEXT NOT NULL CHECK (length(items_json) BETWEEN 2 AND 65536 AND json_valid(items_json)),
  result TEXT NOT NULL CHECK (result IN ('Pass', 'Pass With Defects', 'Fail')),
  defect_count INTEGER NOT NULL CHECK (typeof(defect_count) = 'integer' AND defect_count BETWEEN 0 AND 60),
  out_of_service INTEGER NOT NULL CHECK (out_of_service IN (0, 1)),
  next_inspection_due TEXT CHECK (next_inspection_due IS NULL OR length(next_inspection_due) = 10),
  manifest_key TEXT NOT NULL CHECK (length(manifest_key) BETWEEN 1 AND 512),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  CHECK (
    (result = 'Pass' AND defect_count = 0 AND out_of_service = 0)
    OR (result = 'Pass With Defects' AND defect_count > 0 AND out_of_service = 0)
    OR (result = 'Fail' AND defect_count > 0)
  ),
  UNIQUE (inspection_id, tenant_id, fleet_asset_id),
  FOREIGN KEY (fleet_asset_id, tenant_id) REFERENCES fleet_assets(fleet_asset_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (device_action_id) REFERENCES fleet_asset_actions(device_action_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fleet_defects (
  defect_id TEXT PRIMARY KEY CHECK (
    length(defect_id) BETWEEN 8 AND 180
    AND defect_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  device_action_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  fleet_asset_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_inspection_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('Minor', 'Major', 'Out of Service')),
  detected_at TEXT NOT NULL CHECK (length(detected_at) BETWEEN 20 AND 40),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1200),
  manifest_key TEXT NOT NULL CHECK (length(manifest_key) BETWEEN 1 AND 512),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  FOREIGN KEY (fleet_asset_id, tenant_id) REFERENCES fleet_assets(fleet_asset_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (defect_id, tenant_id),
  FOREIGN KEY (source_inspection_id, tenant_id, fleet_asset_id)
    REFERENCES fleet_inspections(inspection_id, tenant_id, fleet_asset_id) ON DELETE RESTRICT,
  FOREIGN KEY (device_action_id) REFERENCES fleet_asset_actions(device_action_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS fleet_defect_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  defect_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('reported', 'contained', 'scheduled', 'repaired', 'closed', 'cancelled')
  ),
  status TEXT NOT NULL CHECK (status IN ('Open', 'Contained', 'Scheduled', 'Repaired', 'Closed', 'Cancelled')),
  actor_user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  evidence_key TEXT NOT NULL CHECK (length(evidence_key) BETWEEN 1 AND 512),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (defect_id, tenant_id) REFERENCES fleet_defects(defect_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fleet_crews_tenant_status
  ON fleet_crews (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_crew_members_user_active
  ON fleet_crew_members (tenant_id, user_id, active, crew_id);
CREATE INDEX IF NOT EXISTS idx_fleet_assets_tenant_status
  ON fleet_assets (tenant_id, status, asset_kind, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_assets_tenant_command
  ON fleet_assets (tenant_id, last_command_id);
CREATE INDEX IF NOT EXISTS idx_fleet_driver_authorities_user_status
  ON fleet_driver_authorities (tenant_id, user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_cargo_loads_job_status
  ON fleet_cargo_loads (tenant_id, roof_job_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_cargo_loads_driver_status
  ON fleet_cargo_loads (tenant_id, driver_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_asset_events_asset_version
  ON fleet_asset_events (tenant_id, fleet_asset_id, asset_version DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_inspections_asset_time
  ON fleet_inspections (tenant_id, fleet_asset_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_defects_asset_time
  ON fleet_defects (tenant_id, fleet_asset_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_defect_events_defect_time
  ON fleet_defect_events (tenant_id, defect_id, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS fleet_crews_version_guard
BEFORE UPDATE ON fleet_crews
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_crew_identity_immutable')
    WHERE NEW.crew_id != OLD.crew_id OR NEW.tenant_id != OLD.tenant_id;
  SELECT RAISE(ABORT, 'fleet_crew_version_conflict')
    WHERE NEW.version != OLD.version + 1;
END;

CREATE TRIGGER IF NOT EXISTS fleet_crew_members_version_guard
BEFORE UPDATE ON fleet_crew_members
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_crew_membership_identity_immutable')
    WHERE NEW.membership_id != OLD.membership_id OR NEW.tenant_id != OLD.tenant_id
      OR NEW.crew_id != OLD.crew_id OR NEW.user_id != OLD.user_id;
  SELECT RAISE(ABORT, 'fleet_crew_membership_version_conflict')
    WHERE NEW.version != OLD.version + 1;
END;

CREATE TRIGGER IF NOT EXISTS fleet_assets_version_guard
BEFORE UPDATE ON fleet_assets
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_asset_identity_immutable')
    WHERE NEW.fleet_asset_id != OLD.fleet_asset_id OR NEW.tenant_id != OLD.tenant_id;
  SELECT RAISE(ABORT, 'fleet_asset_version_conflict')
    WHERE NEW.version != OLD.version + 1;
  SELECT RAISE(ABORT, 'fleet_asset_retired_terminal')
    WHERE OLD.status = 'Retired' AND NEW.status != 'Retired';
  SELECT RAISE(ABORT, 'fleet_asset_return_to_service_required')
    WHERE OLD.status = 'Out of Service' AND NEW.status = 'Active';
  SELECT RAISE(ABORT, 'fleet_asset_return_to_service_required')
    WHERE OLD.status = 'Out of Service' AND NEW.status NOT IN ('Out of Service', 'Retired');
END;

CREATE TRIGGER IF NOT EXISTS fleet_assets_no_delete
BEFORE DELETE ON fleet_assets
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_assets_append_only_identity');
END;

CREATE TRIGGER IF NOT EXISTS fleet_assets_insert_event
AFTER INSERT ON fleet_assets
FOR EACH ROW BEGIN
  INSERT INTO fleet_asset_events (
    event_id, tenant_id, fleet_asset_id, asset_version, event_kind, command_id,
    actor_user_id, evidence_key, snapshot_json, occurred_at
  ) VALUES (
    NEW.fleet_asset_id || ':v' || NEW.version,
    NEW.tenant_id, NEW.fleet_asset_id, NEW.version, 'created', NEW.last_command_id,
    NEW.last_actor_user_id, NEW.last_evidence_key,
    json_object('status', NEW.status, 'custody_holder_type', NEW.custody_holder_type,
      'custody_user_id', NEW.custody_user_id, 'custody_crew_id', NEW.custody_crew_id,
      'current_meter_milli', NEW.current_meter_milli,
      'next_inspection_due', NEW.next_inspection_due,
      'out_of_service_reason', NEW.out_of_service_reason),
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS fleet_assets_update_event
AFTER UPDATE ON fleet_assets
FOR EACH ROW BEGIN
  INSERT INTO fleet_asset_events (
    event_id, tenant_id, fleet_asset_id, asset_version, event_kind, command_id,
    actor_user_id, evidence_key, snapshot_json, occurred_at
  ) VALUES (
    NEW.fleet_asset_id || ':v' || NEW.version,
    NEW.tenant_id, NEW.fleet_asset_id, NEW.version, 'state_changed', NEW.last_command_id,
    NEW.last_actor_user_id, NEW.last_evidence_key,
    json_object('status', NEW.status, 'custody_holder_type', NEW.custody_holder_type,
      'custody_user_id', NEW.custody_user_id, 'custody_crew_id', NEW.custody_crew_id,
      'current_meter_milli', NEW.current_meter_milli,
      'next_inspection_due', NEW.next_inspection_due,
      'out_of_service_reason', NEW.out_of_service_reason),
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS fleet_asset_events_append_only_update
BEFORE UPDATE ON fleet_asset_events
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_asset_events_immutable');
END;
CREATE TRIGGER IF NOT EXISTS fleet_asset_events_append_only_delete
BEFORE DELETE ON fleet_asset_events
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_asset_events_immutable');
END;

CREATE TRIGGER IF NOT EXISTS fleet_driver_authorities_version_guard
BEFORE UPDATE ON fleet_driver_authorities
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_driver_authority_identity_immutable')
    WHERE NEW.driver_authority_id != OLD.driver_authority_id OR NEW.tenant_id != OLD.tenant_id
      OR NEW.user_id != OLD.user_id;
  SELECT RAISE(ABORT, 'fleet_driver_authority_version_conflict')
    WHERE NEW.version != OLD.version + 1;
  SELECT RAISE(ABORT, 'fleet_driver_authority_retired_terminal')
    WHERE OLD.status = 'Retired' AND NEW.status != 'Retired';
END;

CREATE TRIGGER IF NOT EXISTS fleet_cargo_loads_version_guard
BEFORE UPDATE ON fleet_cargo_loads
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_cargo_load_identity_immutable')
    WHERE NEW.cargo_load_id != OLD.cargo_load_id OR NEW.tenant_id != OLD.tenant_id
      OR NEW.roof_job_id != OLD.roof_job_id;
  SELECT RAISE(ABORT, 'fleet_cargo_load_version_conflict')
    WHERE NEW.version != OLD.version + 1;
  SELECT RAISE(ABORT, 'fleet_cargo_load_terminal')
    WHERE OLD.status IN ('Reconciled', 'Cancelled') AND NEW.status != OLD.status;
END;

-- A load becomes a physical authority only once it is loaded. At that point the
-- driver, the exact authority record, and the asset must all still be active;
-- a Draft load intentionally carries no physical driver authority yet.
CREATE TRIGGER IF NOT EXISTS fleet_cargo_loads_authority_insert_guard
BEFORE INSERT ON fleet_cargo_loads
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_cargo_load_driver_authority_invalid')
  WHERE NEW.status IN ('Loaded', 'In Transit', 'Delivered') AND NOT EXISTS (
    SELECT 1
      FROM fleet_assets asset
      LEFT JOIN fleet_assets trailer
        ON trailer.tenant_id = NEW.tenant_id
       AND trailer.fleet_asset_id = NEW.trailer_asset_id
      JOIN fleet_driver_authorities authority
        ON authority.tenant_id = NEW.tenant_id
       AND authority.driver_authority_id = NEW.driver_authority_id
      JOIN app_users driver
        ON driver.tenant_id = NEW.tenant_id
       AND driver.user_id = NEW.driver_user_id
     WHERE asset.tenant_id = NEW.tenant_id
       AND asset.fleet_asset_id = NEW.fleet_asset_id
       AND asset.status = 'Active'
       AND (NEW.trailer_asset_id IS NULL OR trailer.status = 'Active')
       AND authority.user_id = NEW.driver_user_id
       AND authority.status = 'Active'
       AND authority.authority_source = 'Physical Document'
       AND driver.active = 1
       AND COALESCE(driver.access_role, driver.role) = 'field'
  );
END;

CREATE TRIGGER IF NOT EXISTS fleet_cargo_loads_authority_update_guard
BEFORE UPDATE ON fleet_cargo_loads
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_cargo_load_driver_authority_invalid')
  WHERE NEW.status IN ('Loaded', 'In Transit', 'Delivered') AND NOT EXISTS (
    SELECT 1
      FROM fleet_assets asset
      LEFT JOIN fleet_assets trailer
        ON trailer.tenant_id = NEW.tenant_id
       AND trailer.fleet_asset_id = NEW.trailer_asset_id
      JOIN fleet_driver_authorities authority
        ON authority.tenant_id = NEW.tenant_id
       AND authority.driver_authority_id = NEW.driver_authority_id
      JOIN app_users driver
        ON driver.tenant_id = NEW.tenant_id
       AND driver.user_id = NEW.driver_user_id
     WHERE asset.tenant_id = NEW.tenant_id
       AND asset.fleet_asset_id = NEW.fleet_asset_id
       AND asset.status = 'Active'
       AND (NEW.trailer_asset_id IS NULL OR trailer.status = 'Active')
       AND authority.user_id = NEW.driver_user_id
       AND authority.status = 'Active'
       AND authority.authority_source = 'Physical Document'
       AND driver.active = 1
       AND COALESCE(driver.access_role, driver.role) = 'field'
  );
END;

CREATE TRIGGER IF NOT EXISTS fleet_inspections_authorize_insert
BEFORE INSERT ON fleet_inspections
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_inspection_action_binding_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM fleet_asset_actions action
    WHERE action.device_action_id = NEW.device_action_id
      AND action.tenant_id = NEW.tenant_id
      AND action.user_id = NEW.user_id
      AND action.fleet_asset_id = NEW.fleet_asset_id
      AND action.action_kind = CASE NEW.inspection_type
        WHEN 'Pre-Trip' THEN 'pre_trip_inspection' ELSE 'post_trip_inspection' END
      AND action.payload_hash = NEW.payload_hash
      AND action.manifest_key = NEW.manifest_key
      AND action.status = 'r2_stored'
  );
  SELECT RAISE(ABORT, 'fleet_asset_not_found')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users user
    JOIN fleet_assets asset ON asset.tenant_id = user.tenant_id
    WHERE user.user_id = NEW.user_id AND user.tenant_id = NEW.tenant_id
      AND user.active = 1 AND COALESCE(user.access_role, user.role) = 'field'
      AND asset.fleet_asset_id = NEW.fleet_asset_id AND asset.status != 'Retired'
      AND (
        (asset.custody_holder_type = 'User' AND asset.custody_user_id = NEW.user_id)
        OR (asset.custody_holder_type = 'Crew' AND EXISTS (
          SELECT 1 FROM fleet_crew_members member
          JOIN fleet_crews crew
            ON crew.tenant_id = member.tenant_id
           AND crew.crew_id = member.crew_id
          WHERE member.tenant_id = NEW.tenant_id AND member.crew_id = asset.custody_crew_id
            AND member.user_id = NEW.user_id AND member.active = 1
            AND crew.status = 'Active'
        ))
        OR EXISTS (
          SELECT 1 FROM fleet_cargo_loads load
          JOIN fleet_driver_authorities authority
            ON authority.tenant_id = load.tenant_id
           AND authority.driver_authority_id = load.driver_authority_id
          JOIN app_users driver
            ON driver.tenant_id = load.tenant_id
           AND driver.user_id = load.driver_user_id
          WHERE load.tenant_id = NEW.tenant_id
            AND (load.fleet_asset_id = NEW.fleet_asset_id OR load.trailer_asset_id = NEW.fleet_asset_id)
            AND load.status IN ('Loaded', 'In Transit', 'Delivered')
            AND asset.status = 'Active'
            AND load.driver_user_id = NEW.user_id
            AND authority.user_id = load.driver_user_id
            AND authority.status = 'Active'
            AND authority.authority_source = 'Physical Document'
            AND driver.active = 1
            AND COALESCE(driver.access_role, driver.role) = 'field'
        )
      )
  );
  SELECT RAISE(ABORT, 'fleet_meter_regression')
  WHERE NEW.meter_reading_milli IS NOT NULL AND EXISTS (
    SELECT 1 FROM fleet_assets asset
    WHERE asset.tenant_id = NEW.tenant_id AND asset.fleet_asset_id = NEW.fleet_asset_id
      AND asset.current_meter_milli IS NOT NULL
      AND NEW.meter_reading_milli < asset.current_meter_milli
  );
END;

CREATE TRIGGER IF NOT EXISTS fleet_inspections_apply_asset
AFTER INSERT ON fleet_inspections
FOR EACH ROW BEGIN
  UPDATE fleet_assets
  SET current_meter_milli = CASE
        WHEN NEW.meter_reading_milli IS NULL THEN current_meter_milli
        WHEN current_meter_milli IS NULL OR NEW.meter_reading_milli > current_meter_milli
          THEN NEW.meter_reading_milli ELSE current_meter_milli END,
      status = CASE WHEN NEW.out_of_service = 1 THEN 'Out of Service' ELSE status END,
      last_inspection_id = CASE
        WHEN NEW.result IN ('Pass', 'Pass With Defects')
          AND (last_inspection_at IS NULL OR NEW.performed_at >= last_inspection_at)
          THEN NEW.inspection_id ELSE last_inspection_id END,
      last_inspection_at = CASE
        WHEN NEW.result IN ('Pass', 'Pass With Defects')
          AND (last_inspection_at IS NULL OR NEW.performed_at >= last_inspection_at)
          THEN NEW.performed_at ELSE last_inspection_at END,
      next_inspection_due = CASE
        WHEN NEW.next_inspection_due IS NOT NULL
          AND (next_inspection_due IS NULL OR NEW.next_inspection_due > next_inspection_due)
          THEN NEW.next_inspection_due ELSE next_inspection_due END,
      out_of_service_reason = CASE WHEN NEW.out_of_service = 1
        THEN 'Out-of-service defect found on ' || NEW.inspection_type || ' inspection ' || NEW.device_action_id || '.'
        ELSE out_of_service_reason END,
      out_of_service_at = CASE WHEN NEW.out_of_service = 1 THEN NEW.performed_at ELSE out_of_service_at END,
      version = version + 1,
      last_command_id = NEW.device_action_id,
      last_actor_user_id = NEW.user_id,
      last_evidence_key = NEW.manifest_key,
      updated_at = NEW.created_at
  WHERE tenant_id = NEW.tenant_id AND fleet_asset_id = NEW.fleet_asset_id;
END;

CREATE TRIGGER IF NOT EXISTS fleet_inspections_append_only_update
BEFORE UPDATE ON fleet_inspections
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_inspections_immutable');
END;
CREATE TRIGGER IF NOT EXISTS fleet_inspections_append_only_delete
BEFORE DELETE ON fleet_inspections
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_inspections_immutable');
END;

CREATE TRIGGER IF NOT EXISTS fleet_defects_authorize_insert
BEFORE INSERT ON fleet_defects
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_defect_source_inspection_binding_invalid')
  WHERE NEW.source_inspection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fleet_inspections source
     WHERE source.inspection_id = NEW.source_inspection_id
       AND source.tenant_id = NEW.tenant_id
       AND source.fleet_asset_id = NEW.fleet_asset_id
  );
  SELECT RAISE(ABORT, 'fleet_defect_action_binding_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM fleet_asset_actions action
    WHERE action.device_action_id = NEW.device_action_id
      AND action.tenant_id = NEW.tenant_id
      AND action.user_id = NEW.user_id
      AND action.fleet_asset_id = NEW.fleet_asset_id
      AND action.action_kind = 'defect_report'
      AND action.payload_hash = NEW.payload_hash
      AND action.manifest_key = NEW.manifest_key
      AND action.status = 'r2_stored'
  );
  SELECT RAISE(ABORT, 'fleet_asset_not_found')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users user
    JOIN fleet_assets asset ON asset.tenant_id = user.tenant_id
    WHERE user.user_id = NEW.user_id AND user.tenant_id = NEW.tenant_id
      AND user.active = 1 AND COALESCE(user.access_role, user.role) = 'field'
      AND asset.fleet_asset_id = NEW.fleet_asset_id AND asset.status != 'Retired'
      AND (
        (asset.custody_holder_type = 'User' AND asset.custody_user_id = NEW.user_id)
        OR (asset.custody_holder_type = 'Crew' AND EXISTS (
          SELECT 1 FROM fleet_crew_members member
          JOIN fleet_crews crew
            ON crew.tenant_id = member.tenant_id
           AND crew.crew_id = member.crew_id
          WHERE member.tenant_id = NEW.tenant_id AND member.crew_id = asset.custody_crew_id
            AND member.user_id = NEW.user_id AND member.active = 1
            AND crew.status = 'Active'
        ))
        OR EXISTS (
          SELECT 1 FROM fleet_cargo_loads load
          JOIN fleet_driver_authorities authority
            ON authority.tenant_id = load.tenant_id
           AND authority.driver_authority_id = load.driver_authority_id
          JOIN app_users driver
            ON driver.tenant_id = load.tenant_id
           AND driver.user_id = load.driver_user_id
          WHERE load.tenant_id = NEW.tenant_id
            AND (load.fleet_asset_id = NEW.fleet_asset_id OR load.trailer_asset_id = NEW.fleet_asset_id)
            AND load.status IN ('Loaded', 'In Transit', 'Delivered')
            AND asset.status = 'Active'
            AND load.driver_user_id = NEW.user_id
            AND authority.user_id = load.driver_user_id
            AND authority.status = 'Active'
            AND authority.authority_source = 'Physical Document'
            AND driver.active = 1
            AND COALESCE(driver.access_role, driver.role) = 'field'
        )
      )
  );
END;

CREATE TRIGGER IF NOT EXISTS fleet_defects_insert_event
AFTER INSERT ON fleet_defects
FOR EACH ROW BEGIN
  INSERT INTO fleet_defect_events (
    event_id, tenant_id, defect_id, event_kind, status, actor_user_id,
    command_id, evidence_key, occurred_at
  ) VALUES (
    NEW.defect_id || ':reported', NEW.tenant_id, NEW.defect_id, 'reported', 'Open',
    NEW.user_id, NEW.device_action_id, NEW.manifest_key, NEW.detected_at
  );
  UPDATE fleet_assets
  SET status = CASE WHEN NEW.severity = 'Out of Service' THEN 'Out of Service' ELSE status END,
      out_of_service_reason = CASE WHEN NEW.severity = 'Out of Service'
        THEN 'Out-of-service defect ' || NEW.device_action_id || ' reported from the field.'
        ELSE out_of_service_reason END,
      out_of_service_at = CASE WHEN NEW.severity = 'Out of Service' THEN NEW.detected_at ELSE out_of_service_at END,
      version = version + 1,
      last_command_id = NEW.device_action_id,
      last_actor_user_id = NEW.user_id,
      last_evidence_key = NEW.manifest_key,
      updated_at = NEW.created_at
  WHERE tenant_id = NEW.tenant_id AND fleet_asset_id = NEW.fleet_asset_id;
END;

CREATE TRIGGER IF NOT EXISTS fleet_defects_append_only_update
BEFORE UPDATE ON fleet_defects
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_defects_immutable');
END;
CREATE TRIGGER IF NOT EXISTS fleet_defects_append_only_delete
BEFORE DELETE ON fleet_defects
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_defects_immutable');
END;
CREATE TRIGGER IF NOT EXISTS fleet_defect_events_append_only_update
BEFORE UPDATE ON fleet_defect_events
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_defect_events_immutable');
END;
CREATE TRIGGER IF NOT EXISTS fleet_defect_events_append_only_delete
BEFORE DELETE ON fleet_defect_events
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'fleet_defect_events_immutable');
END;
