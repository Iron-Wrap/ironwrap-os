import type { AppEnv, AuthContext } from "./app-types.ts";

/**
 * Read side of the fleet capture rail.
 *
 * The capture routes have been reachable since IRO-54, but nothing told a
 * driver *which* asset to capture against, or why dispatch would refuse the one
 * they are standing next to. This is that read, and it is deliberately the only
 * fleet read a field session gets: it reads the same D1 authority facts and
 * policy verdicts used by the capture and release rails.
 */

const FLEET_PANEL_ACTIONS = [
  "fleet.pre_trip_inspection.create",
  "fleet.post_trip_inspection.create",
  "fleet.defect_report.create",
] as const;
const MAX_PANEL_ASSETS = 25;
const ROAD_ASSET_KINDS = new Set(["Vehicle", "Trailer"]);

export interface FleetPanelBlocker {
  code: string;
  field: string | null;
  message: string;
}

export interface FleetPanelAsset {
  id: string;
  fleet_asset_id: string;
  display_name: string;
  unit_number: string | null;
  asset_kind: string;
  status: string;
  licence_plate: string | null;
  meter_kind: string | null;
  current_meter: number | null;
  relationship: "custody" | "driver";
  last_inspection_at: string | null;
  next_inspection_due: string | null;
  last_pre_trip_at: string | null;
  last_post_trip_at: string | null;
  out_of_service_reason: string | null;
  open_out_of_service_defects: number;
  blockers: FleetPanelBlocker[];
}

export interface FleetPanelReadModel {
  version: number;
  source_updated_at: string | null;
  read_model_generated_at: string;
  stale_fields: string[];
  permissions: string[];
  allowed_actions: string[];
  reference_date: string | null;
  assets: FleetPanelAsset[];
}

export async function buildFleetPanelReadModel(
  env: AppEnv,
  auth: AuthContext,
): Promise<FleetPanelReadModel> {
  const panel = await readFleetPanel(env, auth);
  return {
    version: 1,
    read_model_generated_at: new Date().toISOString(),
    stale_fields: [],
    permissions: auth.permissions,
    allowed_actions: [...FLEET_PANEL_ACTIONS],
    source_updated_at: panel.sourceUpdatedAt,
    reference_date: panel.referenceDate,
    assets: panel.assets,
  };
}

interface NativeFleetPanelRow {
  fleet_asset_id: string;
  display_name: string;
  unit_number: string | null;
  asset_kind: string;
  status: string;
  licence_plate: string | null;
  meter_kind: string | null;
  current_meter_milli: number | null;
  relationship: "custody" | "driver";
  inspection_authority_source: string;
  last_inspection_at: string | null;
  next_inspection_due: string | null;
  last_pre_trip_at: string | null;
  last_post_trip_at: string | null;
  next_service_due_date: string | null;
  calibration_required: number;
  next_calibration_due: string | null;
  registration_expiry: string | null;
  insurance_expiry: string | null;
  required_licence_class: string | null;
  out_of_service_reason: string | null;
  open_out_of_service_defects: number;
  driver_authority_id: string | null;
  driver_status: string | null;
  driver_authority_source: string | null;
  driver_licence_class: string | null;
  driver_licence_expiry: string | null;
  driver_medical_expiry: string | null;
  updated_at: string;
}

async function readFleetPanel(
  env: AppEnv,
  auth: AuthContext,
): Promise<{
  referenceDate: string;
  sourceUpdatedAt: string | null;
  assets: FleetPanelAsset[];
}> {
  const userId = auth.session.user_id;
  const result = await env.DB.prepare(
    `WITH scoped AS (
       SELECT asset.*,
              CASE WHEN asset.custody_holder_type = 'User' AND asset.custody_user_id = ? THEN 1 ELSE 0 END AS direct_custody,
              EXISTS (
                SELECT 1 FROM fleet_crew_members member
                JOIN fleet_crews crew
                  ON crew.tenant_id = member.tenant_id
                 AND crew.crew_id = member.crew_id
                 WHERE member.tenant_id = asset.tenant_id
                   AND member.crew_id = asset.custody_crew_id
                   AND member.user_id = ? AND member.active = 1
                   AND crew.status = 'Active'
              ) AS crew_custody,
              EXISTS (
                SELECT 1 FROM fleet_cargo_loads load
                JOIN fleet_driver_authorities authority
                  ON authority.tenant_id = load.tenant_id
                 AND authority.driver_authority_id = load.driver_authority_id
                JOIN app_users load_driver
                  ON load_driver.tenant_id = load.tenant_id
                 AND load_driver.user_id = load.driver_user_id
                 WHERE load.tenant_id = asset.tenant_id
                   AND (load.fleet_asset_id = asset.fleet_asset_id
                        OR load.trailer_asset_id = asset.fleet_asset_id)
                   AND asset.status = 'Active'
                   AND load.status IN ('Loaded', 'In Transit', 'Delivered')
                   AND load.driver_user_id = ?
                   AND authority.user_id = load.driver_user_id
                   AND authority.user_id = ?
                   AND load_driver.active = 1
                   AND COALESCE(load_driver.access_role, load_driver.role) = 'field'
              ) AS driver_relationship
         FROM fleet_assets asset
        WHERE asset.tenant_id = ? AND asset.status != 'Retired'
     ), related AS (
       SELECT scoped.*,
              CASE WHEN direct_custody = 1 OR crew_custody = 1 THEN 'custody' ELSE 'driver' END AS relationship
         FROM scoped
        WHERE direct_custody = 1 OR crew_custody = 1 OR driver_relationship = 1
        ORDER BY updated_at DESC, fleet_asset_id
        LIMIT ?
     )
     SELECT related.fleet_asset_id, related.display_name, related.unit_number,
            related.asset_kind, related.status, related.licence_plate,
            related.meter_kind, related.current_meter_milli, related.relationship,
            related.inspection_authority_source, related.last_inspection_at,
            related.next_inspection_due, related.next_service_due_date,
            related.calibration_required, related.next_calibration_due,
            related.registration_expiry, related.insurance_expiry,
            related.required_licence_class, related.out_of_service_reason,
            related.updated_at,
            (SELECT MAX(performed_at) FROM fleet_inspections inspection
              WHERE inspection.tenant_id = related.tenant_id
                AND inspection.fleet_asset_id = related.fleet_asset_id
                AND inspection.inspection_type = 'Pre-Trip') AS last_pre_trip_at,
            (SELECT MAX(performed_at) FROM fleet_inspections inspection
              WHERE inspection.tenant_id = related.tenant_id
                AND inspection.fleet_asset_id = related.fleet_asset_id
                AND inspection.inspection_type = 'Post-Trip') AS last_post_trip_at,
            (SELECT COUNT(*) FROM fleet_defects defect
              WHERE defect.tenant_id = related.tenant_id
                AND defect.fleet_asset_id = related.fleet_asset_id
                AND defect.severity = 'Out of Service'
                AND (SELECT event.status FROM fleet_defect_events event
                      WHERE event.tenant_id = defect.tenant_id AND event.defect_id = defect.defect_id
                      ORDER BY event.occurred_at DESC, event.event_id DESC LIMIT 1)
                    IN ('Open', 'Contained', 'Scheduled')) AS open_out_of_service_defects,
            driver.driver_authority_id, driver.status AS driver_status,
            driver.authority_source AS driver_authority_source,
            driver.licence_class AS driver_licence_class,
            driver.licence_expiry AS driver_licence_expiry,
            driver.medical_expiry AS driver_medical_expiry
       FROM related
       LEFT JOIN fleet_driver_authorities driver
         ON driver.tenant_id = related.tenant_id
        AND driver.driver_authority_id = (
           SELECT authority.driver_authority_id
             FROM fleet_cargo_loads load
             JOIN fleet_driver_authorities authority
               ON authority.tenant_id = load.tenant_id
              AND authority.driver_authority_id = load.driver_authority_id
             JOIN app_users load_driver
               ON load_driver.tenant_id = load.tenant_id
              AND load_driver.user_id = load.driver_user_id
            WHERE load.tenant_id = related.tenant_id
              AND (load.fleet_asset_id = related.fleet_asset_id
                   OR load.trailer_asset_id = related.fleet_asset_id)
              AND load.status IN ('Loaded', 'In Transit', 'Delivered')
              AND load.driver_user_id = ?
              AND authority.user_id = load.driver_user_id
              AND authority.user_id = ?
              AND load_driver.active = 1
              AND COALESCE(load_driver.access_role, load_driver.role) = 'field'
            ORDER BY load.updated_at DESC, authority.updated_at DESC,
                     authority.driver_authority_id
            LIMIT 1
         )
      ORDER BY related.updated_at DESC, related.fleet_asset_id`,
  )
    .bind(
      userId,
      userId,
      userId,
      userId,
      auth.session.tenant_id,
      MAX_PANEL_ASSETS,
      userId,
      userId,
    )
    .all<NativeFleetPanelRow>();
  const referenceDate = new Date().toISOString().slice(0, 10);
  const rows = (result.results ?? []).slice(0, MAX_PANEL_ASSETS);
  return {
    referenceDate,
    sourceUpdatedAt: rows.reduce<string | null>(
      (latest, row) =>
        !latest || row.updated_at > latest ? row.updated_at : latest,
      null,
    ),
    assets: rows.map((row) => panelAsset(row, referenceDate)),
  };
}

function panelAsset(
  row: NativeFleetPanelRow,
  referenceDate: string,
): FleetPanelAsset {
  return {
    id: row.fleet_asset_id,
    fleet_asset_id: row.fleet_asset_id,
    display_name: row.display_name || row.fleet_asset_id,
    unit_number: row.unit_number,
    asset_kind: row.asset_kind,
    status: row.status,
    licence_plate: row.licence_plate,
    meter_kind: row.meter_kind,
    current_meter:
      row.current_meter_milli === null ? null : row.current_meter_milli / 1_000,
    relationship: row.relationship,
    last_inspection_at: row.last_inspection_at,
    next_inspection_due: row.next_inspection_due,
    last_pre_trip_at: row.last_pre_trip_at,
    last_post_trip_at: row.last_post_trip_at,
    out_of_service_reason: row.out_of_service_reason,
    open_out_of_service_defects: Math.max(
      0,
      Math.trunc(row.open_out_of_service_defects),
    ),
    blockers: fleetBlockers(row, referenceDate),
  };
}

function fleetBlockers(
  row: NativeFleetPanelRow,
  referenceDate: string,
): FleetPanelBlocker[] {
  const blockers: FleetPanelBlocker[] = [];
  const assetBlocker = fleetAssetBlocker(row, referenceDate);
  if (assetBlocker) blockers.push(assetBlocker);
  if (row.open_out_of_service_defects > 0) {
    blockers.push(
      blocker(
        "open_out_of_service_defect",
        "fleet_asset",
        "an asset with an open out-of-service defect cannot be scheduled or released",
      ),
    );
  }
  if (
    row.relationship === "driver" &&
    ROAD_ASSET_KINDS.has(row.asset_kind) &&
    row.driver_authority_id
  ) {
    const driverBlocker = fleetDriverBlocker(row, referenceDate);
    if (driverBlocker) blockers.push(driverBlocker);
  }
  return blockers;
}

function fleetAssetBlocker(
  row: NativeFleetPanelRow,
  referenceDate: string,
): FleetPanelBlocker | null {
  if (row.status !== "Active") {
    return blocker(
      "unsafe_fleet_asset",
      "fleet_asset",
      "the linked Fleet Asset must be Active before scheduling or release",
    );
  }
  if (row.inspection_authority_source !== "Physical Inspection") {
    return blocker(
      "telematics_cannot_authorize_asset",
      "fleet_asset",
      "provider telematics never replaces the physical inspection authority for an asset",
    );
  }
  const dates: Array<[string | null, string, string]> = [
    [
      row.next_inspection_due,
      "overdue_fleet_inspection",
      "the linked Fleet Asset inspection is overdue for the scheduled or released work",
    ],
  ];
  if (row.next_service_due_date) {
    dates.push([
      row.next_service_due_date,
      "overdue_fleet_maintenance",
      "the linked Fleet Asset maintenance is overdue for the scheduled or released work",
    ]);
  }
  if (row.calibration_required === 1) {
    dates.push([
      row.next_calibration_due,
      "overdue_fleet_calibration",
      "the linked Fleet Asset calibration is overdue for the scheduled or released work",
    ]);
  }
  if (ROAD_ASSET_KINDS.has(row.asset_kind)) {
    dates.push(
      [
        row.registration_expiry,
        "expired_fleet_registration",
        "the linked Fleet Asset registration expires before the scheduled or released work",
      ],
      [
        row.insurance_expiry,
        "expired_fleet_insurance",
        "the linked Fleet Asset insurance expires before the scheduled or released work",
      ],
    );
  }
  for (const [value, code, message] of dates) {
    if (!value || value < referenceDate) {
      const field =
        code === "overdue_fleet_inspection"
          ? "next_inspection_due"
          : code === "overdue_fleet_maintenance"
            ? "next_service_due_date"
            : code === "overdue_fleet_calibration"
              ? "next_calibration_due"
              : code === "expired_fleet_registration"
                ? "registration_expiry"
                : "insurance_expiry";
      return blocker(code, field, message);
    }
  }
  return null;
}

function fleetDriverBlocker(
  row: NativeFleetPanelRow,
  referenceDate: string,
): FleetPanelBlocker | null {
  if (row.driver_status !== "Active") {
    return blocker(
      "inactive_driver_authority",
      "driver_authority",
      "the linked Driver Authority must be Active before scheduling or release",
    );
  }
  if (row.driver_authority_source !== "Physical Document") {
    return blocker(
      "telematics_cannot_authorize_driver",
      "driver_authority",
      "provider telematics never replaces the physical driver authority document",
    );
  }
  if (!row.driver_licence_expiry || row.driver_licence_expiry < referenceDate) {
    return blocker(
      "expired_driver_licence",
      "licence_expiry",
      "the linked Driver Authority licence expires before the scheduled or released work",
    );
  }
  if (row.driver_medical_expiry && row.driver_medical_expiry < referenceDate) {
    return blocker(
      "expired_driver_medical",
      "medical_expiry",
      "the linked Driver Authority medical expires before the scheduled or released work",
    );
  }
  if (
    row.required_licence_class &&
    !new Set(
      (row.driver_licence_class ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ).has(row.required_licence_class.trim())
  ) {
    return blocker(
      "unlicensed_fleet_driver",
      "driver_authority",
      "the linked Driver Authority does not hold the licence class this asset requires",
    );
  }
  return null;
}

function blocker(
  code: string,
  field: string,
  message: string,
): FleetPanelBlocker {
  return { code, field, message: `[${code}] ${field}: ${message}` };
}
