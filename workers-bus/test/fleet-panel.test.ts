import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";

const PANEL_PATH = "/api/v1/fleet/panel";
/**
 * The panel compares these against the wall clock, so "not due" and "not expired" are relationships
 * to the run rather than calendar dates. A far-future pin still arrives eventually, and when it does
 * the healthy asset silently grows `overdue_fleet_inspection` and `expired_driver_licence`. The
 * deliberately-expired fixtures below stay pinned: a past date only ever gets more past.
 */
const NOT_DUE_YET = new Date(Date.now() + 365 * 24 * 60 * 60_000)
  .toISOString()
  .slice(0, 10);

function auth(
  role: "field" | "owner" | "ops" = "field",
  frappeUser: string | null = null,
): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["today:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-08-20T06:00:00.000Z",
      session_expires_at: "2026-08-21T06:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: frappeUser,
      active: 1,
      created_by: "owner@example.invalid",
      created_at: "2026-08-20T06:00:00.000Z",
      updated_at: "2026-08-20T06:00:00.000Z",
    },
  } as AuthContext;
}

function panelAssetFixture(overrides: Record<string, unknown> = {}) {
  return {
    fleet_asset_id: "asset-truck-1",
    display_name: "Truck 01",
    unit_number: "01",
    asset_kind: "Vehicle",
    status: "Active",
    licence_plate: "ABC-123",
    meter_kind: "Odometer km",
    current_meter_milli: 142000125,
    relationship: "custody",
    inspection_authority_source: "Physical Inspection",
    last_inspection_at: "2026-08-20T06:30:00.000Z",
    next_inspection_due: NOT_DUE_YET,
    last_pre_trip_at: "2026-08-20T06:30:00.000Z",
    last_post_trip_at: null,
    next_service_due_date: NOT_DUE_YET,
    calibration_required: 0,
    next_calibration_due: null,
    registration_expiry: NOT_DUE_YET,
    insurance_expiry: NOT_DUE_YET,
    required_licence_class: "5",
    out_of_service_reason: null,
    open_out_of_service_defects: 0,
    driver_authority_id: null,
    driver_status: null,
    driver_authority_source: null,
    driver_licence_class: null,
    driver_licence_expiry: null,
    driver_medical_expiry: null,
    updated_at: "2026-08-20T06:31:00.000Z",
    ...overrides,
  };
}

function panelEnv(
  rows: Array<Record<string, unknown>>,
  options: { fail?: boolean } = {},
): { env: AppEnv; statements: string[]; bindings: unknown[][] } {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        statements.push(normalized);
        return {
          bind(...values: unknown[]) {
            bindings.push(values);
            return {
              async all() {
                if (options.fail) throw new Error("d1_unavailable");
                return { results: rows };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  return { env, statements, bindings };
}

function panelRequest(path = PANEL_PATH, method = "GET"): Request {
  return new Request(`https://app.example.invalid${path}`, { method });
}

test("a field session reads native fleet assets and the inherited blocker verdict", async () => {
  const stub = panelEnv([
    panelAssetFixture({ next_inspection_due: "2000-01-01" }),
  ]);
  const response = await handleAuthenticatedRoute(
    panelRequest(),
    stub.env,
    auth(),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    source_updated_at: string;
    reference_date: string;
    allowed_actions: string[];
    assets: Array<Record<string, unknown>>;
  };
  assert.equal(body.source_updated_at, "2026-08-20T06:31:00.000Z");
  assert.match(body.reference_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(body.allowed_actions, [
    "fleet.pre_trip_inspection.create",
    "fleet.post_trip_inspection.create",
    "fleet.defect_report.create",
  ]);
  assert.equal(body.assets[0]!.fleet_asset_id, "asset-truck-1");
  assert.equal(body.assets[0]!.current_meter, 142000.125);
  assert.deepEqual(body.assets[0]!.blockers, [
    {
      code: "overdue_fleet_inspection",
      field: "next_inspection_due",
      message:
        "[overdue_fleet_inspection] next_inspection_due: the linked Fleet Asset inspection is overdue for the scheduled or released work",
    },
  ]);
});

test("the native session identity scopes the query even without a Frappe link", async () => {
  const stub = panelEnv([panelAssetFixture()]);
  const response = await handleAuthenticatedRoute(
    panelRequest(`${PANEL_PATH}?actor_user=owner@example.invalid`),
    stub.env,
    auth("field", null),
  );
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { assets: unknown[] }).assets.length,
    1,
  );
  assert.ok(stub.statements[0]!.includes("FROM fleet_assets asset"));
  assert.match(stub.statements[0]!, /fleet_crews/);
  assert.match(stub.statements[0]!, /crew\.status = 'Active'/);
  assert.match(
    stub.statements[0]!,
    /load\.status IN \('Loaded', 'In Transit', 'Delivered'\)/,
  );
  assert.match(stub.statements[0]!, /authority\.user_id = load\.driver_user_id/);
  assert.ok(
    stub.bindings[0]!.filter((value) => value === "appu_field").length >= 5,
  );
  assert.equal(stub.bindings[0]!.includes("owner@example.invalid"), false);
});

test("an office role never reaches native fleet authority", async () => {
  for (const role of ["owner", "ops"] as const) {
    const stub = panelEnv([panelAssetFixture()]);
    const response = await handleAuthenticatedRoute(
      panelRequest(),
      stub.env,
      auth(role),
    );
    assert.equal(response.status, 403, role);
    assert.deepEqual(await response.json(), { error: "field_role_required" });
    assert.equal(stub.statements.length, 0);
  }
});

test("native fleet failures are unavailable, never an empty fleet", async () => {
  const stub = panelEnv([], { fail: true });
  const response = await handleAuthenticatedRoute(
    panelRequest(),
    stub.env,
    auth(),
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream_unavailable" });
});

test("open safety defects and driver authority remain visible as separate blockers", async () => {
  const stub = panelEnv([
    panelAssetFixture({
      relationship: "driver",
      open_out_of_service_defects: 1,
      driver_authority_id: "driver-authority-1",
      driver_status: "Active",
      driver_authority_source: "Physical Document",
      driver_licence_class: "1, 3",
      driver_licence_expiry: NOT_DUE_YET,
    }),
  ]);
  const response = await handleAuthenticatedRoute(
    panelRequest(),
    stub.env,
    auth(),
  );
  const body = (await response.json()) as {
    assets: Array<{ blockers: Array<{ code: string }> }>;
  };
  assert.deepEqual(
    body.assets[0]!.blockers.map((item) => item.code),
    ["open_out_of_service_defect", "unlicensed_fleet_driver"],
  );
});

test("the panel remains bounded even if a database adapter ignores SQL LIMIT", async () => {
  const stub = panelEnv(
    Array.from({ length: 60 }, (_value, index) =>
      panelAssetFixture({
        fleet_asset_id: `asset-${index}`,
        display_name: `Asset ${index}`,
      }),
    ),
  );
  const response = await handleAuthenticatedRoute(
    panelRequest(),
    stub.env,
    auth(),
  );
  assert.equal(
    ((await response.json()) as { assets: unknown[] }).assets.length,
    25,
  );
  assert.ok(stub.bindings[0]!.includes(25));
});

test("the panel is a read and refuses every write method before D1", async () => {
  for (const method of ["POST", "PUT", "DELETE"] as const) {
    const stub = panelEnv([]);
    const response = await handleAuthenticatedRoute(
      panelRequest(PANEL_PATH, method),
      stub.env,
      auth(),
    );
    assert.notEqual(response.status, 200, method);
    assert.equal(stub.statements.length, 0, method);
  }
});
