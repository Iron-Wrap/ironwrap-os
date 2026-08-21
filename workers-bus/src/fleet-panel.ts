import type { AppEnv, AuthContext } from "./app-types.ts";
import { frappeBaseUrl, frappeRequestTimeout } from "./frappe-read.ts";
import { railAuthorizationHeader } from "./rail-frappe-credentials.ts";

/**
 * Read side of the fleet capture rail.
 *
 * The capture routes have been reachable since IRO-54, but nothing told a
 * driver *which* asset to capture against, or why dispatch would refuse the one
 * they are standing next to. This is that read, and it is deliberately the only
 * fleet read a field session gets: the Worker holds no fleet authority of its
 * own, so it asks Frappe for the actor's own assets and Frappe answers with the
 * release fence's own verdict on each. Nothing here recomputes readiness, so
 * the reason a phone shows is the reason the schedule would give.
 */

const PANEL_METHOD = "ironwrap_roofing.fleet_operations_api.read_driver_fleet_panel";
const FLEET_PANEL_ACTIONS = [
  "fleet.pre_trip_inspection.create",
  "fleet.post_trip_inspection.create",
  "fleet.defect_report.create",
] as const;
const MAX_PANEL_ASSETS = 25;
const RELATIONSHIPS = new Set(["custody", "driver"]);

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
  const actorUser = auth.session.frappe_user_id?.trim();
  // A field session with no Frappe identity holds no custody and drives no
  // load, so it owns no asset. An empty panel is the correct answer, and it
  // keeps the rail from being probed for an upstream error either way.
  const panel = actorUser ? await readFleetPanel(env, actorUser) : null;
  return {
    version: 1,
    source_updated_at: null,
    read_model_generated_at: new Date().toISOString(),
    stale_fields: [],
    permissions: auth.permissions,
    allowed_actions: [...FLEET_PANEL_ACTIONS],
    reference_date: panel?.referenceDate ?? null,
    assets: panel?.assets ?? [],
  };
}

async function readFleetPanel(
  env: AppEnv,
  actorUser: string,
): Promise<{ referenceDate: string | null; assets: FleetPanelAsset[] }> {
  const authorization = railAuthorizationHeader(env, "fleet_capture");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS),
  );
  try {
    const response = await fetch(`${frappeBaseUrl(env)}/api/method/${PANEL_METHOD}`, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json",
        "user-agent": "ironwrap-bff/1.0",
      },
      // The actor is the authenticated session's Frappe identity, never a value
      // the browser supplied: the panel's whole scope rests on it.
      body: JSON.stringify({ actor_user: actorUser }),
    });
    if (!response.ok) throw new Error(`fleet_panel_http_${response.status}`);
    const decoded = (await response.json()) as { message?: unknown };
    return parsePanelMessage(decoded.message);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("fleet_panel_timeout");
    if (error instanceof Error && error.message.startsWith("fleet_")) throw error;
    throw new Error("fleet_panel_network_error");
  } finally {
    clearTimeout(timer);
  }
}

function parsePanelMessage(
  message: unknown,
): { referenceDate: string | null; assets: FleetPanelAsset[] } {
  if (!isRecord(message)) throw new Error("fleet_panel_invalid_shape");
  const rows = Array.isArray(message.assets) ? message.assets : [];
  const assets = rows
    .slice(0, MAX_PANEL_ASSETS)
    .map((row) => panelAsset(row))
    .filter((row): row is FleetPanelAsset => row !== null);
  return { referenceDate: text(message.reference_date), assets };
}

function panelAsset(row: unknown): FleetPanelAsset | null {
  if (!isRecord(row)) return null;
  const id = text(row.name);
  const fleetAssetId = text(row.fleet_asset_id);
  const assetKind = text(row.asset_kind);
  const status = text(row.status);
  if (!id || !fleetAssetId || !assetKind || !status) return null;
  const relationship = text(row.relationship);
  return {
    id,
    fleet_asset_id: fleetAssetId,
    // A Fleet Asset always carries a display name, but a phone must never show
    // an empty heading if one is ever missing.
    display_name: text(row.display_name) ?? fleetAssetId,
    unit_number: text(row.unit_number),
    asset_kind: assetKind,
    status,
    licence_plate: text(row.licence_plate),
    meter_kind: text(row.meter_kind),
    current_meter: finiteNumber(row.current_meter),
    relationship: relationship && RELATIONSHIPS.has(relationship) ? (relationship as "custody" | "driver") : "driver",
    last_inspection_at: text(row.last_inspection_at),
    next_inspection_due: text(row.next_inspection_due),
    last_pre_trip_at: text(row.last_pre_trip_at),
    last_post_trip_at: text(row.last_post_trip_at),
    out_of_service_reason: text(row.out_of_service_reason),
    open_out_of_service_defects: Math.max(0, Math.trunc(finiteNumber(row.open_out_of_service_defects) ?? 0)),
    blockers: Array.isArray(row.blockers)
      ? row.blockers.map((entry) => panelBlocker(entry)).filter((entry): entry is FleetPanelBlocker => entry !== null)
      : [],
  };
}

function panelBlocker(value: unknown): FleetPanelBlocker | null {
  if (!isRecord(value)) return null;
  const code = text(value.code);
  if (!code) return null;
  return { code, field: text(value.field), message: text(value.message) ?? code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
