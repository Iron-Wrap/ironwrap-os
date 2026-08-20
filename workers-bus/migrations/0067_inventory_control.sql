-- 0067_inventory_control.sql - tenant inventory command/event/position ledger, valuation,
-- three-way receiving, count/adjustment, barcode capture, and provider reconciliation.
--
-- D1 is the first-write command/event/position ledger.  Frappe remains the normalized
-- operating record, R2 remains immutable evidence, and QuickBooks/AP writes remain
-- external effects that must pass through the 0042 effect runtime.
--
-- Quantities are scaled integers and money is minor units.  No conservation column uses
-- REAL/FLOAT/DECIMAL.  UOM conversion is an explicit versioned rational row, never a
-- floating factor and never an implicit tolerance.
--
-- Conservation is enforced structurally, not by convention:
--   * a position moves only by exactly one event's delta (inventory_positions_movement_guard);
--   * a conserving command's events must sum to zero in both quantity and value
--     (inventory_commands_conservation_guard);
--   * quantity, reserved and quarantined columns are non-negative and reserved+quarantined
--     may never exceed quantity, so negative and phantom stock are unrepresentable.

CREATE TABLE IF NOT EXISTS inventory_items (
  item_id TEXT PRIMARY KEY CHECK (
    length(item_id) BETWEEN 8 AND 160
    AND item_id GLOB '[A-Za-z0-9]*'
    AND item_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  item_code TEXT NOT NULL CHECK (length(trim(item_code)) BETWEEN 1 AND 120),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 1000000),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  item_kind TEXT NOT NULL CHECK (
    item_kind IN ('raw_material', 'consumable', 'finished_product', 'remnant', 'scrap')
  ),
  base_uom_id TEXT NOT NULL,
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  -- Lot-controlled items carry lot-specific actual cost; commodity items fall back to FIFO.
  lot_controlled INTEGER NOT NULL DEFAULT 1 CHECK (lot_controlled IN (0, 1)),
  valuation_method TEXT NOT NULL CHECK (valuation_method IN ('actual', 'fifo')),
  source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) BETWEEN 1 AND 280),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  -- The item identity is stable across revisions so a revision bump can never strand stock.
  UNIQUE (tenant_id, item_code),
  UNIQUE (item_id, tenant_id),
  CHECK ((lot_controlled = 1 AND valuation_method = 'actual')
      OR (lot_controlled = 0 AND valuation_method = 'fifo'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant_code
  ON inventory_items (tenant_id, item_code, status, revision DESC);

CREATE TABLE IF NOT EXISTS inventory_uoms (
  uom_id TEXT PRIMARY KEY CHECK (
    length(uom_id) BETWEEN 8 AND 160
    AND uom_id GLOB '[A-Za-z0-9]*'
    AND uom_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  code TEXT NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  dimension TEXT NOT NULL CHECK (dimension IN ('length', 'area', 'volume', 'mass', 'count')),
  scale INTEGER NOT NULL CHECK (scale BETWEEN 0 AND 6),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, code),
  UNIQUE (uom_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_uoms_tenant_code
  ON inventory_uoms (tenant_id, code, status, version DESC);

-- One rational conversion per ordered pair and version.  numerator/denominator are exact
-- integers: converting quantity q from -> to is (q * numerator) / denominator, and a
-- non-integer result is a rejected conversion, never a rounded one.
CREATE TABLE IF NOT EXISTS inventory_uom_conversions (
  conversion_id TEXT PRIMARY KEY CHECK (
    length(conversion_id) BETWEEN 8 AND 160
    AND conversion_id GLOB '[A-Za-z0-9]*'
    AND conversion_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  from_uom_id TEXT NOT NULL,
  to_uom_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  numerator INTEGER NOT NULL CHECK (numerator > 0),
  denominator INTEGER NOT NULL CHECK (denominator > 0),
  dimension TEXT NOT NULL CHECK (dimension IN ('length', 'area', 'volume', 'mass', 'count')),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  effective_from TEXT NOT NULL CHECK (length(effective_from) BETWEEN 20 AND 40),
  effective_to TEXT CHECK (effective_to IS NULL OR length(effective_to) BETWEEN 20 AND 40),
  source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) BETWEEN 1 AND 280),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, from_uom_id, to_uom_id, version),
  UNIQUE (conversion_id, tenant_id),
  FOREIGN KEY (from_uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT,
  CHECK (from_uom_id != to_uom_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_inventory_uom_conversions_lookup
  ON inventory_uom_conversions (tenant_id, from_uom_id, to_uom_id, status, version DESC);

CREATE TABLE IF NOT EXISTS inventory_locations (
  location_id TEXT PRIMARY KEY CHECK (
    length(location_id) BETWEEN 8 AND 160
    AND location_id GLOB '[A-Za-z0-9]*'
    AND location_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  location_code TEXT NOT NULL CHECK (length(trim(location_code)) BETWEEN 1 AND 80),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  location_kind TEXT NOT NULL CHECK (
    location_kind IN ('warehouse', 'shop', 'job', 'vehicle', 'quarantine', 'scrap')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) BETWEEN 1 AND 280),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, location_code),
  UNIQUE (location_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_locations_tenant_status
  ON inventory_locations (tenant_id, status, location_code);

-- A count freezes the bin for the first release.  freeze_state is the physical control:
-- while 'frozen' no movement command may touch a position in the bin.
CREATE TABLE IF NOT EXISTS inventory_bins (
  bin_id TEXT PRIMARY KEY CHECK (
    length(bin_id) BETWEEN 8 AND 160
    AND bin_id GLOB '[A-Za-z0-9]*'
    AND bin_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  location_id TEXT NOT NULL,
  bin_code TEXT NOT NULL CHECK (length(trim(bin_code)) BETWEEN 1 AND 80),
  bin_kind TEXT NOT NULL CHECK (bin_kind IN ('stock', 'quarantine', 'scrap', 'staging')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  freeze_state TEXT NOT NULL DEFAULT 'open' CHECK (freeze_state IN ('open', 'frozen')),
  frozen_by TEXT,
  frozen_at TEXT,
  freeze_count_session_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, location_id, bin_code),
  UNIQUE (bin_id, tenant_id),
  FOREIGN KEY (location_id, tenant_id)
    REFERENCES inventory_locations(location_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (freeze_state = 'open' AND frozen_by IS NULL AND frozen_at IS NULL
      AND freeze_count_session_id IS NULL)
    OR (freeze_state = 'frozen' AND frozen_by IS NOT NULL AND frozen_at IS NOT NULL
      AND freeze_count_session_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_inventory_bins_tenant_freeze
  ON inventory_bins (tenant_id, freeze_state, location_id, bin_code);

-- A lot is the stable physical identity a receipt creates and a scan resolves.  An offline
-- scan of an unknown identity may only produce 'observed_pending_validation'.
CREATE TABLE IF NOT EXISTS inventory_lots (
  lot_id TEXT PRIMARY KEY CHECK (
    length(lot_id) BETWEEN 8 AND 160
    AND lot_id GLOB '[A-Za-z0-9]*'
    AND lot_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  item_id TEXT NOT NULL,
  lot_code TEXT NOT NULL CHECK (length(trim(lot_code)) BETWEEN 1 AND 120),
  lot_kind TEXT NOT NULL CHECK (
    lot_kind IN ('purchased', 'remnant', 'scrap', 'returned', 'observed')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('observed_pending_validation', 'quarantined', 'available', 'consumed', 'rejected')
  ),
  supplier_ref TEXT CHECK (supplier_ref IS NULL OR length(trim(supplier_ref)) BETWEEN 1 AND 200),
  parent_lot_id TEXT,
  receipt_line_id TEXT,
  unit_cost_minor INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(trim(evidence_refs_json)) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, item_id, lot_code),
  UNIQUE (lot_id, tenant_id),
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES inventory_items(item_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_lot_id, tenant_id)
    REFERENCES inventory_lots(lot_id, tenant_id) ON DELETE RESTRICT,
  -- An observed identity has no cost and no provenance until validation replaces it.
  CHECK ((status = 'observed_pending_validation' AND lot_kind = 'observed' AND unit_cost_minor IS NULL)
      OR (status != 'observed_pending_validation' AND lot_kind != 'observed')),
  CHECK ((lot_kind IN ('remnant', 'scrap') AND parent_lot_id IS NOT NULL)
      OR lot_kind NOT IN ('remnant', 'scrap'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_item_status
  ON inventory_lots (tenant_id, item_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_parent
  ON inventory_lots (tenant_id, parent_lot_id, lot_kind);

-- Every material change is an immutable command first.  The command carries authority,
-- policy, idempotency and the request hash; the events carry the exact movement.
CREATE TABLE IF NOT EXISTS inventory_commands (
  command_id TEXT PRIMARY KEY CHECK (
    length(command_id) BETWEEN 12 AND 200
    AND command_id GLOB '[A-Za-z0-9]*'
    AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  transition TEXT NOT NULL CHECK (transition IN (
    'receive', 'reserve', 'release_reservation', 'issue_use', 'return', 'transfer',
    'quarantine', 'release_quarantine', 'count_freeze', 'count_adjustment', 'yield', 'reversal'
  )),
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('agent', 'worker', 'customer', 'external_authority', 'device', 'owner')
  ),
  actor_user_id TEXT NOT NULL,
  authority_ref TEXT NOT NULL CHECK (length(trim(authority_ref)) BETWEEN 1 AND 280),
  policy_ref TEXT NOT NULL CHECK (length(trim(policy_ref)) BETWEEN 1 AND 280),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 80),
  idempotency_key_sha256 TEXT NOT NULL CHECK (
    length(idempotency_key_sha256) = 64 AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64 AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  approval_id TEXT,
  evidence_refs_json TEXT NOT NULL CHECK (
    length(trim(evidence_refs_json)) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  payload_json TEXT NOT NULL CHECK (
    length(trim(payload_json)) BETWEEN 2 AND 65536 AND json_valid(payload_json)
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'applied', 'rejected', 'conflict', 'reconciliation_required')
  ),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  rejection_code TEXT CHECK (rejection_code IS NULL OR length(rejection_code) BETWEEN 3 AND 120),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key_sha256),
  UNIQUE (command_id, tenant_id),
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_commands_pending
  ON inventory_commands (tenant_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_inventory_commands_transition
  ON inventory_commands (tenant_id, transition, created_at DESC);

-- One event is one movement of one position.  version is the position's CAS sequence.
CREATE TABLE IF NOT EXISTS inventory_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 12 AND 200
    AND event_id GLOB '[A-Za-z0-9]*'
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  command_id TEXT NOT NULL,
  movement_seq INTEGER NOT NULL CHECK (movement_seq BETWEEN 1 AND 1000),
  position_id TEXT NOT NULL CHECK (length(position_id) BETWEEN 8 AND 240),
  version INTEGER NOT NULL CHECK (version >= 1),
  transition TEXT NOT NULL CHECK (transition IN (
    'receive', 'reserve', 'release_reservation', 'issue_use', 'return', 'transfer',
    'quarantine', 'release_quarantine', 'count_freeze', 'count_adjustment', 'yield', 'reversal'
  )),
  item_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  bin_id TEXT NOT NULL,
  uom_id TEXT NOT NULL,
  job_custody TEXT NOT NULL CHECK (length(trim(job_custody)) BETWEEN 1 AND 160),
  quantity_delta_scaled INTEGER NOT NULL,
  reserved_delta_scaled INTEGER NOT NULL DEFAULT 0,
  quarantined_delta_scaled INTEGER NOT NULL DEFAULT 0,
  value_delta_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(trim(evidence_refs_json)) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  payload_json TEXT NOT NULL CHECK (
    length(trim(payload_json)) BETWEEN 2 AND 65536 AND json_valid(payload_json)
  ),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, position_id, version),
  UNIQUE (command_id, movement_seq),
  UNIQUE (event_id, tenant_id),
  FOREIGN KEY (command_id, tenant_id)
    REFERENCES inventory_commands(command_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES inventory_items(item_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (lot_id, tenant_id)
    REFERENCES inventory_lots(lot_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (bin_id, tenant_id)
    REFERENCES inventory_bins(bin_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_events_tenant_time
  ON inventory_events (tenant_id, occurred_at, event_id);

CREATE INDEX IF NOT EXISTS idx_inventory_events_stock
  ON inventory_events (tenant_id, item_id, lot_id, occurred_at, version);

CREATE INDEX IF NOT EXISTS idx_inventory_events_command
  ON inventory_events (command_id, movement_seq);

-- The position is the only mutable projection.  Stock is shared at tenant level; job
-- custody is explicit, so legacy roof_job identifiers stay provenance in payload_json.
CREATE TABLE IF NOT EXISTS inventory_positions (
  position_id TEXT PRIMARY KEY CHECK (length(position_id) BETWEEN 8 AND 240),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  item_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  bin_id TEXT NOT NULL,
  -- '-' is the shared, uncommitted tenant pool.  A NULL here would silently defeat the
  -- uniqueness of the shared position, so custody is always an explicit string.
  job_custody TEXT NOT NULL DEFAULT '-' CHECK (length(trim(job_custody)) BETWEEN 1 AND 160),
  uom_id TEXT NOT NULL,
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled >= 0),
  reserved_scaled INTEGER NOT NULL DEFAULT 0 CHECK (reserved_scaled >= 0),
  quarantined_scaled INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_scaled >= 0),
  value_minor INTEGER NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  version INTEGER NOT NULL CHECK (version >= 1),
  last_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (position_id, tenant_id),
  UNIQUE (tenant_id, item_id, lot_id, bin_id, job_custody),
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES inventory_items(item_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (lot_id, tenant_id)
    REFERENCES inventory_lots(lot_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (bin_id, tenant_id)
    REFERENCES inventory_bins(bin_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (last_event_id, tenant_id)
    REFERENCES inventory_events(event_id, tenant_id) ON DELETE RESTRICT,
  -- No negative and no phantom availability: committed stock can never exceed on-hand.
  CHECK (reserved_scaled + quarantined_scaled <= quantity_scaled)
);

CREATE INDEX IF NOT EXISTS idx_inventory_positions_lookup
  ON inventory_positions (tenant_id, item_id, lot_id, bin_id, job_custody);

CREATE INDEX IF NOT EXISTS idx_inventory_positions_available
  ON inventory_positions (tenant_id, item_id, bin_id, quantity_scaled, reserved_scaled, quarantined_scaled);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  reservation_id TEXT PRIMARY KEY CHECK (
    length(reservation_id) BETWEEN 12 AND 200
    AND reservation_id GLOB '[A-Za-z0-9]*'
    AND reservation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  position_id TEXT NOT NULL,
  job_id TEXT NOT NULL CHECK (length(trim(job_id)) BETWEEN 1 AND 160),
  work_package_id TEXT CHECK (work_package_id IS NULL OR length(trim(work_package_id)) BETWEEN 1 AND 160),
  reserved_quantity_scaled INTEGER NOT NULL CHECK (reserved_quantity_scaled > 0),
  issued_quantity_scaled INTEGER NOT NULL DEFAULT 0 CHECK (issued_quantity_scaled >= 0),
  returned_quantity_scaled INTEGER NOT NULL DEFAULT 0 CHECK (returned_quantity_scaled >= 0),
  uom_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'partially_issued', 'issued', 'released', 'reversed')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  command_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (reservation_id, tenant_id),
  FOREIGN KEY (position_id, tenant_id)
    REFERENCES inventory_positions(position_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (command_id, tenant_id)
    REFERENCES inventory_commands(command_id, tenant_id) ON DELETE RESTRICT,
  -- Issue can never exceed the reservation and returns can never exceed what was issued.
  CHECK (issued_quantity_scaled <= reserved_quantity_scaled),
  CHECK (returned_quantity_scaled <= issued_quantity_scaled)
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_active
  ON inventory_reservations (tenant_id, job_id, status, position_id);

-- Lot-controlled items consume their own actual cost layer; commodity items consume
-- FIFO layers in created_at/layer_id order.  Freight and tax are allocated explicitly.
CREATE TABLE IF NOT EXISTS inventory_valuation_layers (
  layer_id TEXT PRIMARY KEY CHECK (
    length(layer_id) BETWEEN 12 AND 200
    AND layer_id GLOB '[A-Za-z0-9]*'
    AND layer_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  item_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  layer_kind TEXT NOT NULL CHECK (
    layer_kind IN ('receipt', 'return', 'remnant', 'adjustment', 'correction')
  ),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  remaining_scaled INTEGER NOT NULL CHECK (remaining_scaled >= 0),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  goods_value_minor INTEGER NOT NULL CHECK (goods_value_minor >= 0),
  freight_minor INTEGER NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  -- The capitalized value is the exact allocation policy: goods + freight - discount.
  -- Recoverable tax is deliberately excluded from inventory value and carried separately.
  value_minor INTEGER NOT NULL CHECK (value_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  method TEXT NOT NULL CHECK (method IN ('actual', 'fifo')),
  correction_of_layer_id TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (layer_id, tenant_id),
  UNIQUE (tenant_id, source_event_id),
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES inventory_items(item_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (lot_id, tenant_id)
    REFERENCES inventory_lots(lot_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_event_id, tenant_id)
    REFERENCES inventory_events(event_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (correction_of_layer_id, tenant_id)
    REFERENCES inventory_valuation_layers(layer_id, tenant_id) ON DELETE RESTRICT,
  CHECK (remaining_scaled <= quantity_scaled),
  CHECK (value_minor = goods_value_minor + freight_minor - discount_minor),
  CHECK (goods_value_minor = unit_cost_minor * quantity_scaled),
  CHECK ((layer_kind = 'correction' AND correction_of_layer_id IS NOT NULL)
      OR (layer_kind != 'correction' AND correction_of_layer_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_fifo
  ON inventory_valuation_layers (tenant_id, item_id, method, remaining_scaled, created_at, layer_id);

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_lot
  ON inventory_valuation_layers (tenant_id, lot_id, remaining_scaled);

-- Every outbound movement draws from named layers.  The sum of allocation quantities for
-- an event must equal the event's outbound quantity, which is what conserves value.
CREATE TABLE IF NOT EXISTS inventory_valuation_allocations (
  allocation_id TEXT PRIMARY KEY CHECK (
    length(allocation_id) BETWEEN 12 AND 200
    AND allocation_id GLOB '[A-Za-z0-9]*'
    AND allocation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  layer_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  job_custody TEXT NOT NULL CHECK (length(trim(job_custody)) BETWEEN 1 AND 160),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  value_minor INTEGER NOT NULL CHECK (value_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (allocation_id, tenant_id),
  UNIQUE (tenant_id, event_id, layer_id),
  FOREIGN KEY (layer_id, tenant_id)
    REFERENCES inventory_valuation_layers(layer_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, tenant_id)
    REFERENCES inventory_events(event_id, tenant_id) ON DELETE RESTRICT,
  CHECK (value_minor = unit_cost_minor * quantity_scaled)
);

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_allocations_event
  ON inventory_valuation_allocations (tenant_id, event_id, layer_id);

CREATE INDEX IF NOT EXISTS idx_inventory_valuation_allocations_job
  ON inventory_valuation_allocations (tenant_id, job_custody, created_at);

-- Independent approval.  The requesting actor can never be the approver, and a
-- value-bearing adjustment additionally needs a distinct finance reviewer.
CREATE TABLE IF NOT EXISTS inventory_approvals (
  approval_id TEXT PRIMARY KEY CHECK (
    length(approval_id) BETWEEN 12 AND 200
    AND approval_id GLOB '[A-Za-z0-9]*'
    AND approval_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  approval_kind TEXT NOT NULL CHECK (
    approval_kind IN ('count_variance', 'quarantine_release', 'value_adjustment')
  ),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('count_session', 'lot', 'position')
  ),
  subject_id TEXT NOT NULL CHECK (length(trim(subject_id)) BETWEEN 1 AND 240),
  requested_by_user_id TEXT NOT NULL,
  approved_by_user_id TEXT NOT NULL,
  finance_reviewed_by_user_id TEXT,
  value_bearing INTEGER NOT NULL DEFAULT 0 CHECK (value_bearing IN (0, 1)),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) BETWEEN 3 AND 160),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(trim(evidence_refs_json)) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  decided_at TEXT NOT NULL CHECK (length(decided_at) BETWEEN 20 AND 40),
  UNIQUE (approval_id, tenant_id),
  UNIQUE (tenant_id, approval_kind, subject_id),
  FOREIGN KEY (requested_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (finance_reviewed_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  -- Separation of duties is a column constraint, not an application convention.
  CHECK (approved_by_user_id != requested_by_user_id),
  CHECK (finance_reviewed_by_user_id IS NULL
      OR (finance_reviewed_by_user_id != requested_by_user_id
        AND finance_reviewed_by_user_id != approved_by_user_id)),
  CHECK (value_bearing = 0 OR finance_reviewed_by_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_inventory_approvals_subject
  ON inventory_approvals (tenant_id, approval_kind, subject_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS inventory_po_lines (
  po_line_id TEXT PRIMARY KEY CHECK (
    length(po_line_id) BETWEEN 12 AND 200
    AND po_line_id GLOB '[A-Za-z0-9]*'
    AND po_line_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  supplier_order_id TEXT NOT NULL CHECK (length(trim(supplier_order_id)) BETWEEN 1 AND 160),
  provider_po_id TEXT CHECK (provider_po_id IS NULL OR length(trim(provider_po_id)) BETWEEN 1 AND 160),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  item_id TEXT NOT NULL,
  uom_id TEXT NOT NULL,
  ordered_quantity_scaled INTEGER NOT NULL CHECK (ordered_quantity_scaled > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  freight_minor INTEGER NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  -- The exact identity a receipt and an AP invoice must reproduce to be matchable.
  line_identity_sha256 TEXT NOT NULL CHECK (
    length(line_identity_sha256) = 64 AND line_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'ordered', 'partially_received', 'received', 'backordered', 'cancelled', 'exception'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (po_line_id, tenant_id),
  UNIQUE (tenant_id, supplier_order_id, line_no),
  UNIQUE (tenant_id, line_identity_sha256),
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES inventory_items(item_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_po_lines_status
  ON inventory_po_lines (tenant_id, supplier_order_id, status, line_no);

-- A physical receipt line is what a receiver actually observed.  It is never derived
-- from a provider webhook and never asserted by the supplier alone.
CREATE TABLE IF NOT EXISTS inventory_receipt_lines (
  receipt_line_id TEXT PRIMARY KEY CHECK (
    length(receipt_line_id) BETWEEN 12 AND 200
    AND receipt_line_id GLOB '[A-Za-z0-9]*'
    AND receipt_line_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  receipt_id TEXT NOT NULL CHECK (length(trim(receipt_id)) BETWEEN 1 AND 160),
  po_line_id TEXT NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  item_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  uom_id TEXT NOT NULL,
  received_quantity_scaled INTEGER NOT NULL CHECK (received_quantity_scaled > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  freight_minor INTEGER NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  condition_status TEXT NOT NULL CHECK (condition_status IN ('accepted', 'damaged', 'quarantined')),
  exception_status TEXT NOT NULL DEFAULT 'none' CHECK (exception_status IN (
    'none', 'shortage', 'overage', 'backorder', 'substitution', 'unit_difference',
    'price_difference', 'tax_difference', 'freight_difference', 'wrong_lot'
  )),
  received_by_user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL CHECK (
    length(trim(evidence_refs_json)) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (receipt_line_id, tenant_id),
  UNIQUE (tenant_id, receipt_id, line_no),
  FOREIGN KEY (po_line_id, tenant_id)
    REFERENCES inventory_po_lines(po_line_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES inventory_items(item_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (lot_id, tenant_id)
    REFERENCES inventory_lots(lot_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (received_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (command_id, tenant_id)
    REFERENCES inventory_commands(command_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_receipt_lines_po
  ON inventory_receipt_lines (tenant_id, po_line_id, receipt_id, line_no);

-- Provider AP lines enter only from an authenticated readback recorded through the 0042
-- effect runtime.  effect_id is mandatory: a webhook is never match proof.
CREATE TABLE IF NOT EXISTS inventory_invoice_lines (
  invoice_line_id TEXT PRIMARY KEY CHECK (
    length(invoice_line_id) BETWEEN 12 AND 200
    AND invoice_line_id GLOB '[A-Za-z0-9]*'
    AND invoice_line_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  provider TEXT NOT NULL CHECK (provider IN ('quickbooks', 'supplier_ap')),
  provider_invoice_id TEXT NOT NULL CHECK (length(trim(provider_invoice_id)) BETWEEN 1 AND 160),
  provider_bill_id TEXT CHECK (provider_bill_id IS NULL OR length(trim(provider_bill_id)) BETWEEN 1 AND 160),
  provider_vendor_id TEXT NOT NULL CHECK (length(trim(provider_vendor_id)) BETWEEN 1 AND 160),
  po_line_id TEXT NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  item_id TEXT NOT NULL,
  uom_id TEXT NOT NULL,
  invoiced_quantity_scaled INTEGER NOT NULL CHECK (invoiced_quantity_scaled > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  freight_minor INTEGER NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  line_identity_sha256 TEXT NOT NULL CHECK (
    length(line_identity_sha256) = 64 AND line_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  readback_effect_id TEXT NOT NULL,
  readback_hash_sha256 TEXT NOT NULL CHECK (
    length(readback_hash_sha256) = 64 AND readback_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(trim(evidence_refs_json)) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (invoice_line_id, tenant_id),
  UNIQUE (tenant_id, provider, provider_invoice_id, line_no),
  FOREIGN KEY (po_line_id, tenant_id)
    REFERENCES inventory_po_lines(po_line_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES inventory_items(item_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (readback_effect_id)
    REFERENCES external_effects(effect_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_invoice_lines_po
  ON inventory_invoice_lines (tenant_id, po_line_id, provider_invoice_id, line_no);

CREATE TABLE IF NOT EXISTS inventory_three_way_matches (
  match_id TEXT PRIMARY KEY CHECK (
    length(match_id) BETWEEN 12 AND 200
    AND match_id GLOB '[A-Za-z0-9]*'
    AND match_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  po_line_id TEXT NOT NULL,
  receipt_line_id TEXT NOT NULL,
  invoice_line_id TEXT NOT NULL,
  match_state TEXT NOT NULL CHECK (match_state IN ('matched', 'exception')),
  exception_code TEXT CHECK (exception_code IS NULL OR exception_code IN (
    'shortage', 'overage', 'backorder', 'substitution', 'unit_difference',
    'price_difference', 'tax_difference', 'freight_difference', 'wrong_lot',
    'condition_not_accepted', 'currency_difference'
  )),
  identity_digest_sha256 TEXT NOT NULL CHECK (
    length(identity_digest_sha256) = 64 AND identity_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  matched_quantity_scaled INTEGER NOT NULL CHECK (matched_quantity_scaled >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (match_id, tenant_id),
  UNIQUE (tenant_id, po_line_id, receipt_line_id, invoice_line_id),
  FOREIGN KEY (po_line_id, tenant_id)
    REFERENCES inventory_po_lines(po_line_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (receipt_line_id, tenant_id)
    REFERENCES inventory_receipt_lines(receipt_line_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (invoice_line_id, tenant_id)
    REFERENCES inventory_invoice_lines(invoice_line_id, tenant_id) ON DELETE RESTRICT,
  CHECK ((match_state = 'matched' AND exception_code IS NULL AND matched_quantity_scaled > 0)
      OR (match_state = 'exception' AND exception_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_inventory_three_way_state
  ON inventory_three_way_matches (tenant_id, match_state, updated_at);

CREATE TABLE IF NOT EXISTS inventory_exceptions (
  exception_id TEXT PRIMARY KEY CHECK (
    length(exception_id) BETWEEN 12 AND 200
    AND exception_id GLOB '[A-Za-z0-9]*'
    AND exception_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  exception_type TEXT NOT NULL CHECK (exception_type IN (
    'shortage', 'overage', 'backorder', 'substitution', 'unit_difference',
    'price_difference', 'tax_difference', 'freight_difference', 'wrong_lot',
    'count_variance', 'scan_conflict', 'unknown_identity', 'provider_unknown',
    'quarantine_release', 'condition_not_accepted', 'currency_difference'
  )),
  status TEXT NOT NULL CHECK (status IN ('open', 'contained', 'resolved', 'rejected')),
  aggregate_type TEXT NOT NULL CHECK (length(trim(aggregate_type)) BETWEEN 1 AND 80),
  aggregate_id TEXT NOT NULL CHECK (length(trim(aggregate_id)) BETWEEN 1 AND 240),
  reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) BETWEEN 3 AND 160),
  expected_json TEXT NOT NULL CHECK (json_valid(expected_json)),
  observed_json TEXT NOT NULL CHECK (json_valid(observed_json)),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  owner_user_id TEXT,
  resolution_ref TEXT CHECK (resolution_ref IS NULL OR length(trim(resolution_ref)) BETWEEN 1 AND 240),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  resolved_at TEXT CHECK (resolved_at IS NULL OR length(resolved_at) BETWEEN 20 AND 40),
  UNIQUE (exception_id, tenant_id),
  FOREIGN KEY (owner_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK ((status IN ('resolved', 'rejected') AND resolved_at IS NOT NULL)
      OR (status IN ('open', 'contained') AND resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_inventory_exceptions_open
  ON inventory_exceptions (tenant_id, status, exception_type, created_at);

CREATE TABLE IF NOT EXISTS inventory_barcodes (
  barcode_id TEXT PRIMARY KEY CHECK (
    length(barcode_id) BETWEEN 12 AND 200
    AND barcode_id GLOB '[A-Za-z0-9]*'
    AND barcode_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  barcode TEXT NOT NULL CHECK (length(trim(barcode)) BETWEEN 4 AND 240),
  symbology TEXT NOT NULL CHECK (
    symbology IN ('code128', 'datamatrix', 'qr', 'gs1-128', 'ean13')
  ),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('item', 'lot', 'bin')),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 240),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(revoked_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, barcode),
  UNIQUE (barcode_id, tenant_id),
  CHECK ((status = 'revoked' AND revoked_at IS NOT NULL)
      OR (status = 'active' AND revoked_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_inventory_barcodes_entity
  ON inventory_barcodes (tenant_id, entity_type, entity_id, status);

CREATE TABLE IF NOT EXISTS inventory_labels (
  label_id TEXT PRIMARY KEY CHECK (
    length(label_id) BETWEEN 12 AND 200
    AND label_id GLOB '[A-Za-z0-9]*'
    AND label_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  label_type TEXT NOT NULL CHECK (label_type IN ('item', 'lot', 'bin', 'bundle', 'remnant', 'scrap')),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) BETWEEN 1 AND 240),
  label_version INTEGER NOT NULL DEFAULT 1 CHECK (label_version >= 1),
  barcode_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash_sha256 TEXT NOT NULL CHECK (
    length(payload_hash_sha256) = 64 AND payload_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, entity_id, label_type, label_version),
  UNIQUE (label_id, tenant_id),
  FOREIGN KEY (barcode_id, tenant_id)
    REFERENCES inventory_barcodes(barcode_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_labels_entity
  ON inventory_labels (tenant_id, label_type, entity_id, label_version DESC);

-- Offline capture is duplicate-safe by construction: (tenant, device, device_action_id)
-- is unique, so an unbounded replay of a queued scan converges on one row.
CREATE TABLE IF NOT EXISTS inventory_scans (
  scan_id TEXT PRIMARY KEY CHECK (
    length(scan_id) BETWEEN 12 AND 200
    AND scan_id GLOB '[A-Za-z0-9]*'
    AND scan_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  device_id TEXT NOT NULL CHECK (length(trim(device_id)) BETWEEN 8 AND 160),
  device_action_id TEXT NOT NULL CHECK (length(trim(device_action_id)) BETWEEN 8 AND 200),
  actor_user_id TEXT NOT NULL,
  barcode TEXT NOT NULL CHECK (length(trim(barcode)) BETWEEN 4 AND 240),
  scan_intent TEXT NOT NULL CHECK (
    scan_intent IN ('receive', 'issue_use', 'return', 'transfer', 'count', 'lookup')
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64 AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 20 AND 40),
  captured_offline INTEGER NOT NULL DEFAULT 0 CHECK (captured_offline IN (0, 1)),
  resolution TEXT NOT NULL CHECK (resolution IN (
    'resolved', 'duplicate', 'conflict', 'observed_pending_validation', 'rejected'
  )),
  resolved_entity_type TEXT CHECK (
    resolved_entity_type IS NULL OR resolved_entity_type IN ('item', 'lot', 'bin')
  ),
  resolved_entity_id TEXT CHECK (
    resolved_entity_id IS NULL OR length(trim(resolved_entity_id)) BETWEEN 1 AND 240
  ),
  command_id TEXT,
  exception_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (scan_id, tenant_id),
  UNIQUE (tenant_id, device_id, device_action_id),
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (command_id, tenant_id)
    REFERENCES inventory_commands(command_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (exception_id, tenant_id)
    REFERENCES inventory_exceptions(exception_id, tenant_id) ON DELETE RESTRICT,
  CHECK ((resolution = 'resolved' AND resolved_entity_type IS NOT NULL AND resolved_entity_id IS NOT NULL)
      OR resolution != 'resolved')
);

CREATE INDEX IF NOT EXISTS idx_inventory_scans_resolution
  ON inventory_scans (tenant_id, resolution, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_scans_barcode
  ON inventory_scans (tenant_id, barcode, observed_at DESC);

CREATE TABLE IF NOT EXISTS inventory_count_sessions (
  count_session_id TEXT PRIMARY KEY CHECK (
    length(count_session_id) BETWEEN 12 AND 200
    AND count_session_id GLOB '[A-Za-z0-9]*'
    AND count_session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  bin_id TEXT NOT NULL,
  count_type TEXT NOT NULL CHECK (count_type IN ('cycle', 'annual', 'spot')),
  status TEXT NOT NULL CHECK (
    status IN ('frozen', 'counted', 'variance', 'approved', 'rejected', 'closed')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  opened_by_user_id TEXT NOT NULL,
  opened_at TEXT NOT NULL CHECK (length(opened_at) BETWEEN 20 AND 40),
  counted_by_user_id TEXT,
  counted_at TEXT,
  approval_id TEXT,
  released_at TEXT CHECK (released_at IS NULL OR length(released_at) BETWEEN 20 AND 40),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (count_session_id, tenant_id),
  FOREIGN KEY (bin_id, tenant_id)
    REFERENCES inventory_bins(bin_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (opened_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (counted_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (approval_id, tenant_id)
    REFERENCES inventory_approvals(approval_id, tenant_id) ON DELETE RESTRICT,
  -- Closing releases the bin freeze; it is only reachable from a decided approval.
  CHECK ((status = 'closed' AND released_at IS NOT NULL) OR (status != 'closed' AND released_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected', 'closed') AND approval_id IS NOT NULL)
      OR status IN ('frozen', 'counted', 'variance'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_count_sessions_bin
  ON inventory_count_sessions (tenant_id, bin_id, status, opened_at DESC);

CREATE TABLE IF NOT EXISTS inventory_count_lines (
  count_line_id TEXT PRIMARY KEY CHECK (
    length(count_line_id) BETWEEN 12 AND 200
    AND count_line_id GLOB '[A-Za-z0-9]*'
    AND count_line_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  count_session_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  -- Frozen at freeze time so a late movement can never silently rewrite the baseline.
  expected_quantity_scaled INTEGER NOT NULL CHECK (expected_quantity_scaled >= 0),
  counted_quantity_scaled INTEGER CHECK (counted_quantity_scaled IS NULL OR counted_quantity_scaled >= 0),
  variance_scaled INTEGER,
  uom_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'counted', 'variance', 'applied', 'rejected')),
  counted_by_user_id TEXT,
  counted_at TEXT,
  adjustment_command_id TEXT,
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (count_line_id, tenant_id),
  UNIQUE (tenant_id, count_session_id, position_id),
  FOREIGN KEY (count_session_id, tenant_id)
    REFERENCES inventory_count_sessions(count_session_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (position_id, tenant_id)
    REFERENCES inventory_positions(position_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (uom_id, tenant_id)
    REFERENCES inventory_uoms(uom_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (counted_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (adjustment_command_id, tenant_id)
    REFERENCES inventory_commands(command_id, tenant_id) ON DELETE RESTRICT,
  CHECK (counted_quantity_scaled IS NULL
      OR variance_scaled = counted_quantity_scaled - expected_quantity_scaled),
  CHECK ((counted_quantity_scaled IS NULL AND status = 'pending')
      OR (counted_quantity_scaled IS NOT NULL AND status != 'pending'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_variance
  ON inventory_count_lines (tenant_id, count_session_id, status, variance_scaled);

CREATE TABLE IF NOT EXISTS inventory_job_cost_attributions (
  attribution_id TEXT PRIMARY KEY CHECK (
    length(attribution_id) BETWEEN 12 AND 200
    AND attribution_id GLOB '[A-Za-z0-9]*'
    AND attribution_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  event_id TEXT NOT NULL,
  job_id TEXT NOT NULL CHECK (length(trim(job_id)) BETWEEN 1 AND 160),
  quantity_scaled INTEGER NOT NULL CHECK (quantity_scaled > 0),
  value_minor INTEGER NOT NULL CHECK (value_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (length(currency) = 3 AND currency = upper(currency)),
  basis TEXT NOT NULL CHECK (basis IN ('actual', 'fifo', 'count_adjustment', 'correction')),
  -- Operational cost is owned here; accounting truth stays with QuickBooks and may only
  -- be written through the 0042 effect runtime.
  status TEXT NOT NULL CHECK (
    status IN ('operational', 'queued_for_effect', 'reconciled', 'exception')
  ),
  quickbooks_effect_id TEXT,
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (attribution_id, tenant_id),
  UNIQUE (tenant_id, event_id, job_id),
  FOREIGN KEY (event_id, tenant_id)
    REFERENCES inventory_events(event_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (quickbooks_effect_id)
    REFERENCES external_effects(effect_id) ON DELETE RESTRICT,
  CHECK ((status IN ('queued_for_effect', 'reconciled') AND quickbooks_effect_id IS NOT NULL)
      OR status IN ('operational', 'exception'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_job_cost_job
  ON inventory_job_cost_attributions (tenant_id, job_id, status, created_at);

CREATE TABLE IF NOT EXISTS inventory_provider_reconciliations (
  reconciliation_id TEXT PRIMARY KEY CHECK (
    length(reconciliation_id) BETWEEN 12 AND 200
    AND reconciliation_id GLOB '[A-Za-z0-9]*'
    AND reconciliation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  aggregate_type TEXT NOT NULL CHECK (
    aggregate_type IN ('po_line', 'invoice_line', 'three_way_match', 'job_cost')
  ),
  aggregate_id TEXT NOT NULL CHECK (length(trim(aggregate_id)) BETWEEN 1 AND 240),
  provider TEXT NOT NULL CHECK (provider IN ('quickbooks', 'supplier_ap', 'frappe')),
  provider_entity_type TEXT NOT NULL CHECK (
    provider_entity_type IN ('Bill', 'PurchaseOrder', 'Vendor', 'Item', 'JournalEntry')
  ),
  provider_entity_id TEXT CHECK (
    provider_entity_id IS NULL OR length(trim(provider_entity_id)) BETWEEN 1 AND 160
  ),
  external_effect_id TEXT NOT NULL,
  expected_hash_sha256 TEXT NOT NULL CHECK (
    length(expected_hash_sha256) = 64 AND expected_hash_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_hash_sha256 TEXT CHECK (
    observed_hash_sha256 IS NULL
    OR (length(observed_hash_sha256) = 64 AND observed_hash_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'verified', 'unknown', 'conflict', 'reconciled', 'manual_exception')
  ),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (reconciliation_id, tenant_id),
  FOREIGN KEY (external_effect_id)
    REFERENCES external_effects(effect_id) ON DELETE RESTRICT,
  -- 'verified' is only reachable with an observed digest that equals the expectation.
  CHECK ((state = 'verified' AND observed_hash_sha256 = expected_hash_sha256)
      OR state != 'verified')
);

CREATE INDEX IF NOT EXISTS idx_inventory_provider_reconciliations_state
  ON inventory_provider_reconciliations (tenant_id, provider, state, updated_at);

-- ---------------------------------------------------------------------------
-- Append-only and identity guards
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS inventory_items_identity_immutable
BEFORE UPDATE ON inventory_items
BEGIN
  SELECT RAISE(ABORT, 'inventory_item_identity_immutable')
  WHERE NEW.item_id != OLD.item_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.item_code != OLD.item_code
     OR NEW.base_uom_id != OLD.base_uom_id
     OR NEW.quantity_scale != OLD.quantity_scale
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_item_revision_cas_required')
  WHERE NEW.revision != OLD.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS inventory_items_retained
BEFORE DELETE ON inventory_items
BEGIN
  SELECT RAISE(ABORT, 'inventory_items_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_uoms_identity_immutable
BEFORE UPDATE ON inventory_uoms
BEGIN
  SELECT RAISE(ABORT, 'inventory_uom_identity_immutable')
  WHERE NEW.uom_id != OLD.uom_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.code != OLD.code
     OR NEW.dimension != OLD.dimension
     OR NEW.scale != OLD.scale
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_uom_version_cas_required')
  WHERE NEW.version != OLD.version + 1;
END;

CREATE TRIGGER IF NOT EXISTS inventory_uoms_retained
BEFORE DELETE ON inventory_uoms
BEGIN
  SELECT RAISE(ABORT, 'inventory_uoms_retained');
END;

-- A conversion row is a versioned fact; correcting it means writing a new version.
CREATE TRIGGER IF NOT EXISTS inventory_uom_conversions_append_only_update
BEFORE UPDATE ON inventory_uom_conversions
BEGIN
  SELECT RAISE(ABORT, 'inventory_uom_conversions_append_only')
  WHERE NEW.conversion_id != OLD.conversion_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.from_uom_id != OLD.from_uom_id
     OR NEW.to_uom_id != OLD.to_uom_id
     OR NEW.version != OLD.version
     OR NEW.numerator != OLD.numerator
     OR NEW.denominator != OLD.denominator
     OR NEW.dimension != OLD.dimension
     OR NEW.effective_from != OLD.effective_from
     OR NEW.created_at != OLD.created_at;
END;

CREATE TRIGGER IF NOT EXISTS inventory_uom_conversions_retained
BEFORE DELETE ON inventory_uom_conversions
BEGIN
  SELECT RAISE(ABORT, 'inventory_uom_conversions_retained');
END;

-- A conversion may only relate two units of the same physical dimension.
CREATE TRIGGER IF NOT EXISTS inventory_uom_conversions_dimension_guard
BEFORE INSERT ON inventory_uom_conversions
BEGIN
  SELECT RAISE(ABORT, 'inventory_uom_conversion_dimension_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_uoms AS source
    JOIN inventory_uoms AS target
      ON target.uom_id = NEW.to_uom_id AND target.tenant_id = NEW.tenant_id
    WHERE source.uom_id = NEW.from_uom_id
      AND source.tenant_id = NEW.tenant_id
      AND source.dimension = NEW.dimension
      AND target.dimension = NEW.dimension
  );
END;

CREATE TRIGGER IF NOT EXISTS inventory_locations_identity_immutable
BEFORE UPDATE ON inventory_locations
BEGIN
  SELECT RAISE(ABORT, 'inventory_location_identity_immutable')
  WHERE NEW.location_id != OLD.location_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.location_code != OLD.location_code
     OR NEW.location_kind != OLD.location_kind
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_location_version_cas_required')
  WHERE NEW.version != OLD.version + 1;
END;

CREATE TRIGGER IF NOT EXISTS inventory_locations_retained
BEFORE DELETE ON inventory_locations
BEGIN
  SELECT RAISE(ABORT, 'inventory_locations_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_bins_identity_immutable
BEFORE UPDATE ON inventory_bins
BEGIN
  SELECT RAISE(ABORT, 'inventory_bin_identity_immutable')
  WHERE NEW.bin_id != OLD.bin_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.location_id != OLD.location_id
     OR NEW.bin_code != OLD.bin_code
     OR NEW.bin_kind != OLD.bin_kind
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_bin_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  -- A frozen bin is released by the count session that froze it, never by another.
  SELECT RAISE(ABORT, 'inventory_bin_freeze_release_mismatch')
  WHERE OLD.freeze_state = 'frozen'
    AND NEW.freeze_state = 'open'
    AND NOT EXISTS (
      SELECT 1
      FROM inventory_count_sessions AS session
      WHERE session.count_session_id = OLD.freeze_count_session_id
        AND session.tenant_id = OLD.tenant_id
        AND session.status = 'closed'
    );
END;

CREATE TRIGGER IF NOT EXISTS inventory_bins_retained
BEFORE DELETE ON inventory_bins
BEGIN
  SELECT RAISE(ABORT, 'inventory_bins_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_lots_identity_immutable
BEFORE UPDATE ON inventory_lots
BEGIN
  SELECT RAISE(ABORT, 'inventory_lot_identity_immutable')
  WHERE NEW.lot_id != OLD.lot_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.item_id != OLD.item_id
     OR NEW.lot_code != OLD.lot_code
     OR NEW.parent_lot_id IS NOT OLD.parent_lot_id
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_lot_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  -- Actual cost is set once when the receipt establishes it.
  SELECT RAISE(ABORT, 'inventory_lot_cost_immutable')
  WHERE OLD.unit_cost_minor IS NOT NULL AND NEW.unit_cost_minor IS NOT OLD.unit_cost_minor;

  -- Quarantined stock is released only against a decided, independent approval.
  SELECT RAISE(ABORT, 'inventory_lot_quarantine_release_approval_required')
  WHERE OLD.status = 'quarantined'
    AND NEW.status = 'available'
    AND NOT EXISTS (
      SELECT 1
      FROM inventory_approvals AS approval
      WHERE approval.tenant_id = NEW.tenant_id
        AND approval.approval_kind = 'quarantine_release'
        AND approval.subject_type = 'lot'
        AND approval.subject_id = NEW.lot_id
        AND approval.decision = 'approved'
    );
END;

CREATE TRIGGER IF NOT EXISTS inventory_lots_retained
BEFORE DELETE ON inventory_lots
BEGIN
  SELECT RAISE(ABORT, 'inventory_lots_retained');
END;

-- The receiver of a quarantined lot may not approve its own release.
CREATE TRIGGER IF NOT EXISTS inventory_approvals_separation_of_duties
BEFORE INSERT ON inventory_approvals
BEGIN
  SELECT RAISE(ABORT, 'inventory_approval_business_actor_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM app_users AS approver
    WHERE approver.user_id = NEW.approved_by_user_id
      AND approver.tenant_id = NEW.tenant_id
      AND approver.active = 1
      -- 0038 makes access_role the sole effective application role: a sales user stored
      -- under the legacy office class must not inherit approval authority here.
      AND approver.access_role IN ('owner', 'ops')
  );

  SELECT RAISE(ABORT, 'inventory_approval_receiver_cannot_release')
  WHERE NEW.approval_kind = 'quarantine_release'
    AND EXISTS (
      SELECT 1
      FROM inventory_receipt_lines AS line
      WHERE line.tenant_id = NEW.tenant_id
        AND line.lot_id = NEW.subject_id
        AND line.received_by_user_id = NEW.approved_by_user_id
    );

  SELECT RAISE(ABORT, 'inventory_approval_counter_cannot_approve')
  WHERE NEW.approval_kind = 'count_variance'
    AND EXISTS (
      SELECT 1
      FROM inventory_count_sessions AS session
      WHERE session.tenant_id = NEW.tenant_id
        AND session.count_session_id = NEW.subject_id
        AND (session.counted_by_user_id = NEW.approved_by_user_id
          OR session.opened_by_user_id = NEW.approved_by_user_id)
    );

  SELECT RAISE(ABORT, 'inventory_approval_counter_cannot_review_finance')
  WHERE NEW.approval_kind = 'count_variance'
    AND NEW.finance_reviewed_by_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM inventory_count_sessions AS session
      WHERE session.tenant_id = NEW.tenant_id
        AND session.count_session_id = NEW.subject_id
        AND (session.counted_by_user_id = NEW.finance_reviewed_by_user_id
          OR session.opened_by_user_id = NEW.finance_reviewed_by_user_id)
    );
END;

CREATE TRIGGER IF NOT EXISTS inventory_approvals_append_only_update
BEFORE UPDATE ON inventory_approvals
BEGIN
  SELECT RAISE(ABORT, 'inventory_approvals_append_only');
END;

CREATE TRIGGER IF NOT EXISTS inventory_approvals_retained
BEFORE DELETE ON inventory_approvals
BEGIN
  SELECT RAISE(ABORT, 'inventory_approvals_retained');
END;

-- ---------------------------------------------------------------------------
-- Command, event and position conservation
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS inventory_commands_validate_actor
BEFORE INSERT ON inventory_commands
BEGIN
  SELECT RAISE(ABORT, 'inventory_command_actor_role_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM app_users AS actor
    WHERE actor.user_id = NEW.actor_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      -- Effective role, not the legacy storage class (see 0038).
      AND actor.access_role IN ('owner', 'ops', 'field')
  );

  -- A count adjustment can only exist behind a decided independent approval.
  SELECT RAISE(ABORT, 'inventory_command_approval_required')
  WHERE NEW.transition = 'count_adjustment'
    AND (NEW.approval_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM inventory_approvals AS approval
      WHERE approval.approval_id = NEW.approval_id
        AND approval.tenant_id = NEW.tenant_id
        AND approval.approval_kind = 'count_variance'
        AND approval.decision = 'approved'
    ));
END;

CREATE TRIGGER IF NOT EXISTS inventory_commands_identity_immutable
BEFORE UPDATE ON inventory_commands
BEGIN
  SELECT RAISE(ABORT, 'inventory_command_identity_immutable')
  WHERE NEW.command_id != OLD.command_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.transition != OLD.transition
     OR NEW.actor_type != OLD.actor_type
     OR NEW.actor_user_id != OLD.actor_user_id
     OR NEW.authority_ref != OLD.authority_ref
     OR NEW.policy_ref != OLD.policy_ref
     OR NEW.policy_version != OLD.policy_version
     OR NEW.idempotency_key_sha256 != OLD.idempotency_key_sha256
     OR NEW.request_fingerprint_sha256 != OLD.request_fingerprint_sha256
     OR NEW.approval_id IS NOT OLD.approval_id
     OR NEW.evidence_refs_json != OLD.evidence_refs_json
     OR NEW.payload_json != OLD.payload_json
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_command_transition_invalid')
  WHERE OLD.status != 'pending'
    OR NEW.status NOT IN ('applied', 'rejected', 'conflict', 'reconciliation_required');

  SELECT RAISE(ABORT, 'inventory_command_completion_time_required')
  WHERE NEW.status != 'pending' AND NEW.completed_at IS NULL;

  SELECT RAISE(ABORT, 'inventory_command_rejection_code_required')
  WHERE NEW.status IN ('rejected', 'conflict') AND NEW.rejection_code IS NULL;
END;

-- The conservation gate. An applied command must have moved something, and a conserving
-- transition must net to exactly zero in quantity — and, where value travels with the
-- goods, in value too. Mixed units are refused rather than silently summed.
CREATE TRIGGER IF NOT EXISTS inventory_commands_conservation_guard
BEFORE UPDATE ON inventory_commands
WHEN NEW.status = 'applied'
BEGIN
  SELECT RAISE(ABORT, 'inventory_command_movement_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory_events AS movement WHERE movement.command_id = NEW.command_id
  );

  SELECT RAISE(ABORT, 'inventory_command_uom_mixed')
  WHERE NEW.transition IN ('transfer', 'yield', 'reversal')
    AND (
      SELECT COUNT(DISTINCT movement.uom_id)
      FROM inventory_events AS movement
      WHERE movement.command_id = NEW.command_id
    ) > 1;

  SELECT RAISE(ABORT, 'inventory_command_quantity_not_conserved')
  WHERE NEW.transition IN (
      'transfer', 'yield', 'reversal', 'reserve', 'release_reservation',
      'quarantine', 'release_quarantine', 'count_freeze'
    )
    AND (
      SELECT COALESCE(SUM(movement.quantity_delta_scaled), 0)
      FROM inventory_events AS movement
      WHERE movement.command_id = NEW.command_id
    ) != 0;

  SELECT RAISE(ABORT, 'inventory_command_value_not_conserved')
  WHERE NEW.transition IN ('transfer', 'yield', 'reversal')
    AND (
      SELECT COALESCE(SUM(movement.value_delta_minor), 0)
      FROM inventory_events AS movement
      WHERE movement.command_id = NEW.command_id
    ) != 0;

  SELECT RAISE(ABORT, 'inventory_command_reservation_not_conserved')
  WHERE NEW.transition IN ('reserve', 'release_reservation')
    AND (
      SELECT COALESCE(SUM(movement.quarantined_delta_scaled), 0)
      FROM inventory_events AS movement
      WHERE movement.command_id = NEW.command_id
    ) != 0;

  SELECT RAISE(ABORT, 'inventory_command_quarantine_not_conserved')
  WHERE NEW.transition IN ('quarantine', 'release_quarantine')
    AND (
      SELECT COALESCE(SUM(movement.reserved_delta_scaled), 0)
      FROM inventory_events AS movement
      WHERE movement.command_id = NEW.command_id
    ) != 0;

  SELECT RAISE(ABORT, 'inventory_command_direction_invalid')
  WHERE (NEW.transition IN ('receive', 'return')
      AND (
        SELECT MIN(movement.quantity_delta_scaled)
        FROM inventory_events AS movement
        WHERE movement.command_id = NEW.command_id
      ) < 0)
    OR (NEW.transition = 'issue_use'
      AND (
        SELECT MAX(movement.quantity_delta_scaled)
        FROM inventory_events AS movement
        WHERE movement.command_id = NEW.command_id
      ) > 0);

  -- Every outbound quantity must be fully drawn from named valuation layers, so cost
  -- can never be invented and can never be lost.
  SELECT RAISE(ABORT, 'inventory_command_valuation_not_allocated')
  WHERE NEW.transition IN ('issue_use', 'yield', 'transfer')
    AND EXISTS (
      SELECT 1
      FROM inventory_events AS movement
      WHERE movement.command_id = NEW.command_id
        AND movement.quantity_delta_scaled < 0
        AND -movement.quantity_delta_scaled != (
          SELECT COALESCE(SUM(allocation.quantity_scaled), 0)
          FROM inventory_valuation_allocations AS allocation
          WHERE allocation.event_id = movement.event_id
            AND allocation.tenant_id = movement.tenant_id
        )
    );
END;

CREATE TRIGGER IF NOT EXISTS inventory_commands_retained
BEFORE DELETE ON inventory_commands
BEGIN
  SELECT RAISE(ABORT, 'inventory_commands_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_events_append_only_update
BEFORE UPDATE ON inventory_events
BEGIN
  SELECT RAISE(ABORT, 'inventory_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS inventory_events_retained
BEFORE DELETE ON inventory_events
BEGIN
  SELECT RAISE(ABORT, 'inventory_events_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_events_command_binding_guard
BEFORE INSERT ON inventory_events
BEGIN
  -- A movement may only be written while its command is still open, and it must carry
  -- the command's own transition. A settled command can never grow another leg.
  SELECT RAISE(ABORT, 'inventory_event_command_binding_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_commands AS command
    WHERE command.command_id = NEW.command_id
      AND command.tenant_id = NEW.tenant_id
      AND command.transition = NEW.transition
      AND command.status = 'pending'
  );

  -- A movement must sit exactly one version above the position it moves, or open it at 1.
  SELECT RAISE(ABORT, 'inventory_event_position_version_conflict')
  WHERE NEW.version != 1 + COALESCE((
    SELECT position.version
    FROM inventory_positions AS position
    WHERE position.position_id = NEW.position_id
      AND position.tenant_id = NEW.tenant_id
  ), 0);

  -- The lot must belong to the item being moved.
  SELECT RAISE(ABORT, 'inventory_event_lot_item_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_lots AS lot
    WHERE lot.lot_id = NEW.lot_id
      AND lot.tenant_id = NEW.tenant_id
      AND lot.item_id = NEW.item_id
  );

  -- A frozen bin admits only the count transitions that operate on the freeze itself.
  SELECT RAISE(ABORT, 'inventory_event_bin_frozen')
  WHERE NEW.transition NOT IN ('count_freeze', 'count_adjustment')
    AND EXISTS (
      SELECT 1
      FROM inventory_bins AS bin
      WHERE bin.bin_id = NEW.bin_id
        AND bin.tenant_id = NEW.tenant_id
        AND bin.freeze_state = 'frozen'
    );

  -- Stock that only exists as an unvalidated observation may not move into use.
  SELECT RAISE(ABORT, 'inventory_event_lot_not_validated')
  WHERE NEW.transition IN ('reserve', 'issue_use', 'transfer', 'yield')
    AND EXISTS (
      SELECT 1
      FROM inventory_lots AS lot
      WHERE lot.lot_id = NEW.lot_id
        AND lot.tenant_id = NEW.tenant_id
        AND lot.status IN ('observed_pending_validation', 'quarantined', 'rejected')
    );
END;

-- The single strongest invariant: a position may only move by exactly the delta of the
-- event it names. Nothing else can create, destroy, or silently restate stock or value.
CREATE TRIGGER IF NOT EXISTS inventory_positions_movement_guard
BEFORE UPDATE ON inventory_positions
BEGIN
  SELECT RAISE(ABORT, 'inventory_position_identity_immutable')
  WHERE NEW.position_id != OLD.position_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.item_id != OLD.item_id
     OR NEW.lot_id != OLD.lot_id
     OR NEW.bin_id != OLD.bin_id
     OR NEW.job_custody != OLD.job_custody
     OR NEW.uom_id != OLD.uom_id
     OR NEW.currency != OLD.currency
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_position_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  SELECT RAISE(ABORT, 'inventory_position_event_delta_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_events AS movement
    WHERE movement.event_id = NEW.last_event_id
      AND movement.tenant_id = NEW.tenant_id
      AND movement.position_id = NEW.position_id
      AND movement.version = NEW.version
      AND movement.item_id = NEW.item_id
      AND movement.lot_id = NEW.lot_id
      AND movement.bin_id = NEW.bin_id
      AND movement.uom_id = NEW.uom_id
      AND movement.job_custody = NEW.job_custody
      AND NEW.quantity_scaled - OLD.quantity_scaled = movement.quantity_delta_scaled
      AND NEW.reserved_scaled - OLD.reserved_scaled = movement.reserved_delta_scaled
      AND NEW.quarantined_scaled - OLD.quarantined_scaled = movement.quarantined_delta_scaled
      AND NEW.value_minor - OLD.value_minor = movement.value_delta_minor
  );
END;

-- Opening a position is the same rule measured from zero.
CREATE TRIGGER IF NOT EXISTS inventory_positions_open_guard
BEFORE INSERT ON inventory_positions
BEGIN
  SELECT RAISE(ABORT, 'inventory_position_open_event_mismatch')
  WHERE NEW.version != 1
     OR NOT EXISTS (
    SELECT 1
    FROM inventory_events AS movement
    WHERE movement.event_id = NEW.last_event_id
      AND movement.tenant_id = NEW.tenant_id
      AND movement.position_id = NEW.position_id
      AND movement.version = 1
      AND movement.item_id = NEW.item_id
      AND movement.lot_id = NEW.lot_id
      AND movement.bin_id = NEW.bin_id
      AND movement.uom_id = NEW.uom_id
      AND movement.job_custody = NEW.job_custody
      AND NEW.quantity_scaled = movement.quantity_delta_scaled
      AND NEW.reserved_scaled = movement.reserved_delta_scaled
      AND NEW.quarantined_scaled = movement.quarantined_delta_scaled
      AND NEW.value_minor = movement.value_delta_minor
  );
END;

CREATE TRIGGER IF NOT EXISTS inventory_positions_retained
BEFORE DELETE ON inventory_positions
BEGIN
  SELECT RAISE(ABORT, 'inventory_positions_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_reservations_identity_immutable
BEFORE UPDATE ON inventory_reservations
BEGIN
  SELECT RAISE(ABORT, 'inventory_reservation_identity_immutable')
  WHERE NEW.reservation_id != OLD.reservation_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.position_id != OLD.position_id
     OR NEW.job_id != OLD.job_id
     OR NEW.uom_id != OLD.uom_id
     OR NEW.command_id != OLD.command_id
     OR NEW.reserved_quantity_scaled != OLD.reserved_quantity_scaled
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_reservation_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  SELECT RAISE(ABORT, 'inventory_reservation_issue_monotonic')
  WHERE NEW.issued_quantity_scaled < OLD.issued_quantity_scaled
     OR NEW.returned_quantity_scaled < OLD.returned_quantity_scaled;
END;

CREATE TRIGGER IF NOT EXISTS inventory_reservations_retained
BEFORE DELETE ON inventory_reservations
BEGIN
  SELECT RAISE(ABORT, 'inventory_reservations_retained');
END;

-- ---------------------------------------------------------------------------
-- Valuation
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS inventory_valuation_layers_binding_guard
BEFORE INSERT ON inventory_valuation_layers
BEGIN
  -- A layer only exists because an inbound movement created it, for the same identity.
  SELECT RAISE(ABORT, 'inventory_valuation_event_binding_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_events AS movement
    WHERE movement.event_id = NEW.source_event_id
      AND movement.tenant_id = NEW.tenant_id
      AND movement.item_id = NEW.item_id
      AND movement.lot_id = NEW.lot_id
      AND movement.quantity_delta_scaled = NEW.quantity_scaled
      AND movement.value_delta_minor = NEW.value_minor
  );

  -- The valuation method is the item's, never the caller's preference.
  SELECT RAISE(ABORT, 'inventory_valuation_method_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_items AS item
    WHERE item.item_id = NEW.item_id
      AND item.tenant_id = NEW.tenant_id
      AND item.valuation_method = NEW.method
  );

  SELECT RAISE(ABORT, 'inventory_valuation_correction_target_missing')
  WHERE NEW.correction_of_layer_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM inventory_valuation_layers AS target
      WHERE target.layer_id = NEW.correction_of_layer_id
        AND target.tenant_id = NEW.tenant_id
    );
END;

-- A layer's cost is immutable; only its unconsumed remainder may fall, never rise.
CREATE TRIGGER IF NOT EXISTS inventory_valuation_layers_consumption_guard
BEFORE UPDATE ON inventory_valuation_layers
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_layer_immutable')
  WHERE NEW.layer_id != OLD.layer_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.item_id != OLD.item_id
     OR NEW.lot_id != OLD.lot_id
     OR NEW.source_event_id != OLD.source_event_id
     OR NEW.layer_kind != OLD.layer_kind
     OR NEW.quantity_scaled != OLD.quantity_scaled
     OR NEW.unit_cost_minor != OLD.unit_cost_minor
     OR NEW.goods_value_minor != OLD.goods_value_minor
     OR NEW.freight_minor != OLD.freight_minor
     OR NEW.tax_minor != OLD.tax_minor
     OR NEW.discount_minor != OLD.discount_minor
     OR NEW.value_minor != OLD.value_minor
     OR NEW.method != OLD.method
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_valuation_layer_remaining_monotonic')
  WHERE NEW.remaining_scaled > OLD.remaining_scaled;

  -- The drop must equal exactly what the allocations drew from this layer.
  SELECT RAISE(ABORT, 'inventory_valuation_layer_consumption_unallocated')
  WHERE OLD.remaining_scaled - NEW.remaining_scaled != COALESCE((
    SELECT SUM(allocation.quantity_scaled)
    FROM inventory_valuation_allocations AS allocation
    WHERE allocation.layer_id = NEW.layer_id
      AND allocation.tenant_id = NEW.tenant_id
  ), 0) - (OLD.quantity_scaled - OLD.remaining_scaled);
END;

CREATE TRIGGER IF NOT EXISTS inventory_valuation_layers_retained
BEFORE DELETE ON inventory_valuation_layers
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_layers_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_valuation_allocations_binding_guard
BEFORE INSERT ON inventory_valuation_allocations
BEGIN
  -- Allocation draws the layer's own unit cost; a caller cannot restate it.
  SELECT RAISE(ABORT, 'inventory_valuation_allocation_unit_cost_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_valuation_layers AS layer
    WHERE layer.layer_id = NEW.layer_id
      AND layer.tenant_id = NEW.tenant_id
      AND layer.unit_cost_minor = NEW.unit_cost_minor
      AND layer.remaining_scaled >= NEW.quantity_scaled
  );

  -- An allocation is only meaningful against an outbound movement of the same item.
  SELECT RAISE(ABORT, 'inventory_valuation_allocation_event_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_events AS movement
    JOIN inventory_valuation_layers AS layer
      ON layer.layer_id = NEW.layer_id AND layer.tenant_id = NEW.tenant_id
    WHERE movement.event_id = NEW.event_id
      AND movement.tenant_id = NEW.tenant_id
      AND movement.quantity_delta_scaled < 0
      AND movement.item_id = layer.item_id
      AND -movement.quantity_delta_scaled >= NEW.quantity_scaled
  );
END;

CREATE TRIGGER IF NOT EXISTS inventory_valuation_allocations_append_only_update
BEFORE UPDATE ON inventory_valuation_allocations
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_allocations_append_only');
END;

CREATE TRIGGER IF NOT EXISTS inventory_valuation_allocations_retained
BEFORE DELETE ON inventory_valuation_allocations
BEGIN
  SELECT RAISE(ABORT, 'inventory_valuation_allocations_retained');
END;

-- ---------------------------------------------------------------------------
-- Receiving, AP identity and three-way match
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS inventory_po_lines_identity_immutable
BEFORE UPDATE ON inventory_po_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_po_line_identity_immutable')
  WHERE NEW.po_line_id != OLD.po_line_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.supplier_order_id != OLD.supplier_order_id
     OR NEW.line_no != OLD.line_no
     OR NEW.item_id != OLD.item_id
     OR NEW.uom_id != OLD.uom_id
     OR NEW.ordered_quantity_scaled != OLD.ordered_quantity_scaled
     OR NEW.unit_price_minor != OLD.unit_price_minor
     OR NEW.line_identity_sha256 != OLD.line_identity_sha256
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_po_line_version_cas_required')
  WHERE NEW.version != OLD.version + 1;
END;

CREATE TRIGGER IF NOT EXISTS inventory_po_lines_retained
BEFORE DELETE ON inventory_po_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_po_lines_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_receipt_lines_binding_guard
BEFORE INSERT ON inventory_receipt_lines
BEGIN
  -- Receiving against the wrong item, unit or lot is a rejected write, not a warning.
  SELECT RAISE(ABORT, 'inventory_receipt_line_po_identity_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_po_lines AS ordered
    WHERE ordered.po_line_id = NEW.po_line_id
      AND ordered.tenant_id = NEW.tenant_id
      AND ordered.item_id = NEW.item_id
      AND ordered.uom_id = NEW.uom_id
      AND ordered.currency = NEW.currency
  );

  SELECT RAISE(ABORT, 'inventory_receipt_line_lot_item_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_lots AS lot
    WHERE lot.lot_id = NEW.lot_id
      AND lot.tenant_id = NEW.tenant_id
      AND lot.item_id = NEW.item_id
  );

  -- Damaged or quarantined goods can never be booked as an accepted line.
  SELECT RAISE(ABORT, 'inventory_receipt_line_condition_exception_required')
  WHERE NEW.condition_status != 'accepted' AND NEW.exception_status = 'none';
END;

CREATE TRIGGER IF NOT EXISTS inventory_receipt_lines_append_only_update
BEFORE UPDATE ON inventory_receipt_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_receipt_lines_append_only');
END;

CREATE TRIGGER IF NOT EXISTS inventory_receipt_lines_retained
BEFORE DELETE ON inventory_receipt_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_receipt_lines_retained');
END;

-- An AP line is admissible only from a succeeded, authenticated provider readback.
-- A webhook notification is never sufficient.
CREATE TRIGGER IF NOT EXISTS inventory_invoice_lines_readback_guard
BEFORE INSERT ON inventory_invoice_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_invoice_line_authenticated_readback_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM external_effects AS effect
    WHERE effect.effect_id = NEW.readback_effect_id
      AND effect.tenant_id = NEW.tenant_id
      AND effect.state IN ('succeeded', 'reconciled')
      AND effect.readback_hash = NEW.readback_hash_sha256
  );

  SELECT RAISE(ABORT, 'inventory_invoice_line_po_identity_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_po_lines AS ordered
    WHERE ordered.po_line_id = NEW.po_line_id
      AND ordered.tenant_id = NEW.tenant_id
      AND ordered.item_id = NEW.item_id
  );
END;

CREATE TRIGGER IF NOT EXISTS inventory_invoice_lines_append_only_update
BEFORE UPDATE ON inventory_invoice_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_invoice_lines_append_only');
END;

CREATE TRIGGER IF NOT EXISTS inventory_invoice_lines_retained
BEFORE DELETE ON inventory_invoice_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_invoice_lines_retained');
END;

-- 'matched' requires exact line identity across order, physical receipt and AP invoice.
-- A partial delivery is legitimately matchable for the quantity actually received; the
-- order shortfall is a backorder on the PO line, not a falsified match.
CREATE TRIGGER IF NOT EXISTS inventory_three_way_identity_guard
BEFORE INSERT ON inventory_three_way_matches
WHEN NEW.match_state = 'matched'
BEGIN
  SELECT RAISE(ABORT, 'inventory_three_way_exact_identity_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_po_lines AS ordered
    JOIN inventory_receipt_lines AS received
      ON received.receipt_line_id = NEW.receipt_line_id
     AND received.tenant_id = ordered.tenant_id
     AND received.po_line_id = ordered.po_line_id
    JOIN inventory_invoice_lines AS invoiced
      ON invoiced.invoice_line_id = NEW.invoice_line_id
     AND invoiced.tenant_id = ordered.tenant_id
     AND invoiced.po_line_id = ordered.po_line_id
    WHERE ordered.po_line_id = NEW.po_line_id
      AND ordered.tenant_id = NEW.tenant_id
      AND ordered.item_id = received.item_id
      AND ordered.item_id = invoiced.item_id
      AND ordered.uom_id = received.uom_id
      AND ordered.uom_id = invoiced.uom_id
      AND ordered.currency = received.currency
      AND ordered.currency = invoiced.currency
      AND ordered.unit_price_minor = received.unit_price_minor
      AND ordered.unit_price_minor = invoiced.unit_price_minor
      AND received.received_quantity_scaled = invoiced.invoiced_quantity_scaled
      AND received.tax_minor = invoiced.tax_minor
      AND received.freight_minor = invoiced.freight_minor
      AND received.condition_status = 'accepted'
      AND received.exception_status = 'none'
      AND received.received_quantity_scaled <= ordered.ordered_quantity_scaled
      AND NEW.matched_quantity_scaled = received.received_quantity_scaled
  );
END;

CREATE TRIGGER IF NOT EXISTS inventory_three_way_matches_identity_immutable
BEFORE UPDATE ON inventory_three_way_matches
BEGIN
  SELECT RAISE(ABORT, 'inventory_three_way_identity_immutable')
  WHERE NEW.match_id != OLD.match_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.po_line_id != OLD.po_line_id
     OR NEW.receipt_line_id != OLD.receipt_line_id
     OR NEW.invoice_line_id != OLD.invoice_line_id
     OR NEW.identity_digest_sha256 != OLD.identity_digest_sha256
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_three_way_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  -- An exception may be resolved into a match only by rewriting the underlying lines,
  -- which is a new match row; the state never silently upgrades in place.
  SELECT RAISE(ABORT, 'inventory_three_way_state_upgrade_forbidden')
  WHERE OLD.match_state = 'exception' AND NEW.match_state = 'matched';
END;

CREATE TRIGGER IF NOT EXISTS inventory_three_way_matches_retained
BEFORE DELETE ON inventory_three_way_matches
BEGIN
  SELECT RAISE(ABORT, 'inventory_three_way_matches_retained');
END;

-- ---------------------------------------------------------------------------
-- Exceptions, scans and counts
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS inventory_exceptions_identity_immutable
BEFORE UPDATE ON inventory_exceptions
BEGIN
  SELECT RAISE(ABORT, 'inventory_exception_identity_immutable')
  WHERE NEW.exception_id != OLD.exception_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.exception_type != OLD.exception_type
     OR NEW.aggregate_type != OLD.aggregate_type
     OR NEW.aggregate_id != OLD.aggregate_id
     OR NEW.expected_json != OLD.expected_json
     OR NEW.observed_json != OLD.observed_json
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_exception_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  SELECT RAISE(ABORT, 'inventory_exception_reopen_forbidden')
  WHERE OLD.status IN ('resolved', 'rejected');

  -- Closure needs a named owner and a resolution reference, never a bare status flip.
  SELECT RAISE(ABORT, 'inventory_exception_closure_evidence_required')
  WHERE NEW.status IN ('resolved', 'rejected')
    AND (NEW.owner_user_id IS NULL OR NEW.resolution_ref IS NULL);
END;

CREATE TRIGGER IF NOT EXISTS inventory_exceptions_retained
BEFORE DELETE ON inventory_exceptions
BEGIN
  SELECT RAISE(ABORT, 'inventory_exceptions_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_barcodes_identity_immutable
BEFORE UPDATE ON inventory_barcodes
BEGIN
  SELECT RAISE(ABORT, 'inventory_barcode_identity_immutable')
  WHERE NEW.barcode_id != OLD.barcode_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.barcode != OLD.barcode
     OR NEW.symbology != OLD.symbology
     OR NEW.entity_type != OLD.entity_type
     OR NEW.entity_id != OLD.entity_id
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_barcode_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  SELECT RAISE(ABORT, 'inventory_barcode_revocation_final')
  WHERE OLD.status = 'revoked';
END;

CREATE TRIGGER IF NOT EXISTS inventory_barcodes_retained
BEFORE DELETE ON inventory_barcodes
BEGIN
  SELECT RAISE(ABORT, 'inventory_barcodes_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_labels_append_only_update
BEFORE UPDATE ON inventory_labels
BEGIN
  SELECT RAISE(ABORT, 'inventory_labels_append_only');
END;

CREATE TRIGGER IF NOT EXISTS inventory_labels_retained
BEFORE DELETE ON inventory_labels
BEGIN
  SELECT RAISE(ABORT, 'inventory_labels_retained');
END;

-- A captured scan is an observation. It is never rewritten by a later replay.
CREATE TRIGGER IF NOT EXISTS inventory_scans_append_only_update
BEFORE UPDATE ON inventory_scans
BEGIN
  SELECT RAISE(ABORT, 'inventory_scans_append_only');
END;

CREATE TRIGGER IF NOT EXISTS inventory_scans_retained
BEFORE DELETE ON inventory_scans
BEGIN
  SELECT RAISE(ABORT, 'inventory_scans_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_count_sessions_transition_guard
BEFORE UPDATE ON inventory_count_sessions
BEGIN
  SELECT RAISE(ABORT, 'inventory_count_session_identity_immutable')
  WHERE NEW.count_session_id != OLD.count_session_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.bin_id != OLD.bin_id
     OR NEW.count_type != OLD.count_type
     OR NEW.opened_by_user_id != OLD.opened_by_user_id
     OR NEW.opened_at != OLD.opened_at;

  SELECT RAISE(ABORT, 'inventory_count_session_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  -- The freeze is the first step, so no state can be reached without passing through it.
  SELECT RAISE(ABORT, 'inventory_count_session_transition_invalid')
  WHERE NOT (
    (OLD.status = 'frozen' AND NEW.status IN ('counted', 'rejected'))
    OR (OLD.status = 'counted' AND NEW.status IN ('variance', 'approved', 'rejected'))
    OR (OLD.status = 'variance' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status IN ('approved', 'rejected') AND NEW.status = 'closed')
  );

  -- A non-zero variance can never be approved without an independent decided approval.
  SELECT RAISE(ABORT, 'inventory_count_variance_approval_required')
  WHERE NEW.status = 'approved'
    AND EXISTS (
      SELECT 1
      FROM inventory_count_lines AS line
      WHERE line.count_session_id = NEW.count_session_id
        AND line.tenant_id = NEW.tenant_id
        AND COALESCE(line.variance_scaled, 0) != 0
    )
    AND NOT EXISTS (
      SELECT 1
      FROM inventory_approvals AS approval
      WHERE approval.approval_id = NEW.approval_id
        AND approval.tenant_id = NEW.tenant_id
        AND approval.approval_kind = 'count_variance'
        AND approval.subject_id = NEW.count_session_id
        AND approval.decision = 'approved'
    );

  -- The counter may never be the person who opened the count.
  SELECT RAISE(ABORT, 'inventory_count_counter_separation_required')
  WHERE NEW.counted_by_user_id IS NOT NULL
    AND NEW.counted_by_user_id = NEW.opened_by_user_id;
END;

CREATE TRIGGER IF NOT EXISTS inventory_count_sessions_retained
BEFORE DELETE ON inventory_count_sessions
BEGIN
  SELECT RAISE(ABORT, 'inventory_count_sessions_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_count_lines_transition_guard
BEFORE UPDATE ON inventory_count_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_count_line_identity_immutable')
  WHERE NEW.count_line_id != OLD.count_line_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.count_session_id != OLD.count_session_id
     OR NEW.position_id != OLD.position_id
     OR NEW.expected_quantity_scaled != OLD.expected_quantity_scaled
     OR NEW.uom_id != OLD.uom_id
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_count_line_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  -- A recorded physical count is an observation; recounting means a new session.
  SELECT RAISE(ABORT, 'inventory_count_line_recount_forbidden')
  WHERE OLD.counted_quantity_scaled IS NOT NULL
    AND NEW.counted_quantity_scaled IS NOT OLD.counted_quantity_scaled;

  SELECT RAISE(ABORT, 'inventory_count_line_adjustment_requires_approved_session')
  WHERE NEW.status = 'applied'
    AND NOT EXISTS (
      SELECT 1
      FROM inventory_count_sessions AS session
      WHERE session.count_session_id = NEW.count_session_id
        AND session.tenant_id = NEW.tenant_id
        AND session.status IN ('approved', 'closed')
    );
END;

CREATE TRIGGER IF NOT EXISTS inventory_count_lines_retained
BEFORE DELETE ON inventory_count_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_count_lines_retained');
END;

-- ---------------------------------------------------------------------------
-- Job cost and provider reconciliation
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS inventory_job_cost_binding_guard
BEFORE INSERT ON inventory_job_cost_attributions
BEGIN
  -- Job cost is only ever the value that actually left stock for that job.
  SELECT RAISE(ABORT, 'inventory_job_cost_event_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_events AS movement
    WHERE movement.event_id = NEW.event_id
      AND movement.tenant_id = NEW.tenant_id
      AND movement.quantity_delta_scaled = -NEW.quantity_scaled
      AND movement.value_delta_minor = -NEW.value_minor
      AND movement.currency = NEW.currency
  );
END;

CREATE TRIGGER IF NOT EXISTS inventory_job_cost_identity_immutable
BEFORE UPDATE ON inventory_job_cost_attributions
BEGIN
  SELECT RAISE(ABORT, 'inventory_job_cost_identity_immutable')
  WHERE NEW.attribution_id != OLD.attribution_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.event_id != OLD.event_id
     OR NEW.job_id != OLD.job_id
     OR NEW.quantity_scaled != OLD.quantity_scaled
     OR NEW.value_minor != OLD.value_minor
     OR NEW.basis != OLD.basis
     OR NEW.created_at != OLD.created_at;
END;

CREATE TRIGGER IF NOT EXISTS inventory_job_cost_retained
BEFORE DELETE ON inventory_job_cost_attributions
BEGIN
  SELECT RAISE(ABORT, 'inventory_job_cost_attributions_retained');
END;

CREATE TRIGGER IF NOT EXISTS inventory_provider_reconciliations_transition_guard
BEFORE UPDATE ON inventory_provider_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'inventory_provider_reconciliation_identity_immutable')
  WHERE NEW.reconciliation_id != OLD.reconciliation_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.aggregate_type != OLD.aggregate_type
     OR NEW.aggregate_id != OLD.aggregate_id
     OR NEW.provider != OLD.provider
     OR NEW.external_effect_id != OLD.external_effect_id
     OR NEW.expected_hash_sha256 != OLD.expected_hash_sha256
     OR NEW.created_at != OLD.created_at;

  SELECT RAISE(ABORT, 'inventory_provider_reconciliation_version_cas_required')
  WHERE NEW.version != OLD.version + 1;

  -- An unknown provider result is never silently retried into success.
  SELECT RAISE(ABORT, 'inventory_provider_reconciliation_transition_invalid')
  WHERE NOT (
    (OLD.state = 'pending' AND NEW.state IN ('verified', 'unknown', 'conflict'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('reconciled', 'conflict', 'manual_exception'))
    OR (OLD.state = 'conflict' AND NEW.state IN ('reconciled', 'manual_exception'))
  );
END;

CREATE TRIGGER IF NOT EXISTS inventory_provider_reconciliations_retained
BEFORE DELETE ON inventory_provider_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'inventory_provider_reconciliations_retained');
END;
