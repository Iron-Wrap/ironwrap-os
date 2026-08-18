-- Durable receipts for bounded offline fleet captures (pre/post-trip
-- inspections and defect reports). This is not a generic Frappe write queue:
-- the BFF scopes every command and Frappe independently revalidates the asset,
-- the inspector, and the lifecycle rule under its own lock.
--
-- The device action id is the idempotency boundary, so a driver who loses
-- connectivity mid-submit replays the identical capture safely; the same id
-- bound to different facts is rejected as a conflict, never overwritten.

CREATE TABLE IF NOT EXISTS fleet_asset_actions (
  device_action_id TEXT PRIMARY KEY CHECK (
    length(device_action_id) BETWEEN 8 AND 80
    AND device_action_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 120),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 140),
  fleet_asset_id TEXT NOT NULL CHECK (
    length(fleet_asset_id) BETWEEN 1 AND 140
    AND fleet_asset_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  action_kind TEXT NOT NULL CHECK (
    action_kind IN ('pre_trip_inspection', 'post_trip_inspection', 'defect_report')
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('processing', 'r2_stored', 'verified', 'retryable_error')),
  manifest_key TEXT,
  processing_token TEXT,
  lease_expires_at TEXT,
  response_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  CHECK (
    (status = 'verified' AND response_json IS NOT NULL AND verified_at IS NOT NULL)
    OR (status != 'verified' AND verified_at IS NULL)
  ),
  FOREIGN KEY (user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fleet_asset_actions_asset_created
  ON fleet_asset_actions (tenant_id, fleet_asset_id, created_at DESC, device_action_id DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_asset_actions_recovery
  ON fleet_asset_actions (status, lease_expires_at, updated_at)
  WHERE status IN ('processing', 'r2_stored', 'retryable_error');
